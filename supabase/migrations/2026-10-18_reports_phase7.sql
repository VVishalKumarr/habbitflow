-- =====================================================================
-- Phase 7: development reports, programmes, CSV import/export, PDF reports,
-- academic-year transition.
--
-- * Programmes: institution development / habit programmes students join and
--   check in to (one check-in per day; a weekly target).
-- * Development score 1–10 from five components (academic 35, homework 20,
--   attendance 15, planning/habits 15, extracurricular/skills 15 — weights
--   configurable per institution). Each component is 0–1; components without
--   enough data are left out and the weights re-normalised; below half the
--   total weight the result is "insufficient data", never a low score.
--   Planning/habits uses the student's personal timetable only if the student
--   shares it with their school; long or late-night schedules are capped,
--   not rewarded. Every calculation is kept (history).
-- * Exports (CSV in the app): attendance, marks, assignments, development,
--   class reports — only classes the caller can see.
-- * CSV import: students/teachers (invitations; role chosen in the app, never
--   taken from the file), classes, subject assignments; dry run first, row
--   errors, duplicates, summary, audit.
-- * Academic-year transition: new year, classes promoted / repeated /
--   graduated, enrolments carried over, old classes archived (history kept).
-- Additive. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings: development weights
-- ---------------------------------------------------------------------
create or replace function public.institution_settings(p_inst uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'homework_retention_days', 7,
    'max_deadlines_per_day', 2,
    'max_deadlines_per_week', 6,
    'allow_rejection', true,
    'grading_scale', jsonb_build_array(
      jsonb_build_object('label', 'A1', 'min', 91), jsonb_build_object('label', 'A2', 'min', 81),
      jsonb_build_object('label', 'B1', 'min', 71), jsonb_build_object('label', 'B2', 'min', 61),
      jsonb_build_object('label', 'C1', 'min', 51), jsonb_build_object('label', 'C2', 'min', 41),
      jsonb_build_object('label', 'D', 'min', 33), jsonb_build_object('label', 'E', 'min', 0)),
    'attendance_statuses', jsonb_build_array('present', 'absent', 'late', 'excused'),
    'development_weights', jsonb_build_object('academic', 35, 'homework', 20, 'attendance', 15, 'planning', 15, 'extracurricular', 15)
  ) || coalesce((select settings from public.institutions where id = p_inst), '{}'::jsonb);
$$;

create or replace function public.validate_institution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := new.settings;
  k text;
  g jsonb;
  w jsonb;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'Unknown time zone.';
  end if;
  if jsonb_typeof(s) <> 'object' then
    raise exception 'Settings must be an object.';
  end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('homework_retention_days', 'max_deadlines_per_day', 'max_deadlines_per_week', 'grading_scale',
                 'attendance_statuses', 'allow_rejection', 'development_weights') then
      raise exception 'Unknown setting: %', k;
    end if;
  end loop;
  if s ? 'homework_retention_days' and (jsonb_typeof(s -> 'homework_retention_days') <> 'number'
     or (s ->> 'homework_retention_days')::numeric not between 0 and 14
     or (s ->> 'homework_retention_days')::numeric <> trunc((s ->> 'homework_retention_days')::numeric)) then
    raise exception 'The homework review/retention interval must be a whole number of days from 0 to 14.';
  end if;
  if s ? 'max_deadlines_per_day' and (jsonb_typeof(s -> 'max_deadlines_per_day') <> 'number'
     or (s ->> 'max_deadlines_per_day')::numeric not between 1 and 10) then
    raise exception 'Maximum deadlines per day must be between 1 and 10.';
  end if;
  if s ? 'max_deadlines_per_week' and (jsonb_typeof(s -> 'max_deadlines_per_week') <> 'number'
     or (s ->> 'max_deadlines_per_week')::numeric not between 1 and 40) then
    raise exception 'Maximum deadlines per week must be between 1 and 40.';
  end if;
  if s ? 'allow_rejection' and jsonb_typeof(s -> 'allow_rejection') <> 'boolean' then
    raise exception 'allow_rejection must be true or false.';
  end if;
  if s ? 'grading_scale' then
    if jsonb_typeof(s -> 'grading_scale') <> 'array' or jsonb_array_length(s -> 'grading_scale') not between 1 and 20 then
      raise exception 'The grading scale needs 1 to 20 grades.';
    end if;
    for g in select * from jsonb_array_elements(s -> 'grading_scale') loop
      if jsonb_typeof(g) <> 'object' or jsonb_typeof(g -> 'label') <> 'string' or jsonb_typeof(g -> 'min') <> 'number'
         or char_length(btrim(g ->> 'label')) not between 1 and 10 or (g ->> 'min')::numeric not between 0 and 100 then
        raise exception 'Each grade needs a label (up to 10 characters) and a minimum percentage from 0 to 100.';
      end if;
    end loop;
  end if;
  if s ? 'attendance_statuses' then
    if jsonb_typeof(s -> 'attendance_statuses') <> 'array' or jsonb_array_length(s -> 'attendance_statuses') not between 2 and 10
       or not (s -> 'attendance_statuses') ? 'present' or not (s -> 'attendance_statuses') ? 'absent'
       or exists (select 1 from jsonb_array_elements(s -> 'attendance_statuses') e
                  where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[a-z_]{2,20}$') then
      raise exception 'Attendance statuses: 2–10 lower-case names including present and absent.';
    end if;
  end if;
  if s ? 'development_weights' then
    w := s -> 'development_weights';
    if jsonb_typeof(w) <> 'object'
       or (select array_agg(x order by x) from jsonb_object_keys(w) x) <> array['academic', 'attendance', 'extracurricular', 'homework', 'planning']
       or exists (select 1 from jsonb_each(w) e where jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 100
                  or (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric))
       or (select sum((e.value #>> '{}')::numeric) from jsonb_each(w) e) <> 100 then
      raise exception 'Development weights: whole numbers for academic, homework, attendance, planning and extracurricular that add up to 100.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Students choose whether their school may use their habit consistency
-- (personal timetable ticks) and completed personal goals in development
-- reports. Off by default.
alter table public.profiles add column if not exists share_habits_with_school boolean not null default false;
grant update (share_habits_with_school) on public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- Programmes
-- ---------------------------------------------------------------------
create table if not exists public.development_programmes (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  title          text not null check (char_length(btrim(title)) between 1 and 120),
  description    text check (description is null or char_length(description) <= 2000),
  category       text not null default 'habit' check (category in ('habit', 'skill', 'sport', 'arts', 'service', 'academic', 'other')),
  grade          text check (grade is null or char_length(btrim(grade)) between 1 and 30),
  class_id       uuid,
  starts_on      date not null default current_date,
  ends_on        date,
  weekly_target  smallint not null default 3 check (weekly_target between 1 and 7),
  status         text not null default 'active' check (status in ('active', 'archived')),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  check (class_id is null or grade is null),
  unique (id, institution_id),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade
);
create index if not exists programmes_inst_idx on public.development_programmes (institution_id, status);

create table if not exists public.programme_members (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  programme_id   uuid not null,
  student_id     uuid not null,
  joined_at      timestamptz not null default now(),
  left_at        timestamptz,
  unique (programme_id, student_id),
  foreign key (programme_id, institution_id) references public.development_programmes (id, institution_id) on delete cascade,
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade
);
create index if not exists programme_members_student_idx on public.programme_members (student_id);

create table if not exists public.programme_checkins (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  programme_id   uuid not null,
  student_id     uuid not null,
  day            date not null,
  note           text check (note is null or char_length(note) <= 300),
  created_at     timestamptz not null default now(),
  unique (programme_id, student_id, day),
  foreign key (programme_id, institution_id) references public.development_programmes (id, institution_id) on delete cascade,
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade
);
create index if not exists programme_checkins_student_idx on public.programme_checkins (student_id, day);

-- Who may create/edit a programme for this audience.
create or replace function public.can_manage_programme(p_inst uuid, p_grade text, p_class uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  c public.classes;
begin
  if r is null or not public.has_inst_perm(p_inst, 'manage_programmes') then
    return false;
  end if;
  if r in ('principal', 'director') then
    return true;
  end if;
  if p_class is not null then
    select * into c from public.classes where id = p_class and institution_id = p_inst;
    if c.id is null then
      return false;
    end if;
    return (r = 'coordinator' and public.in_coordinator_scope(p_inst, c.grade))
        or c.class_teacher_id = public.my_membership_id(p_inst);
  end if;
  if r = 'coordinator' then
    return public.in_coordinator_scope(p_inst, coalesce(p_grade, '*'));
  end if;
  return false;
end;
$$;
revoke execute on function public.can_manage_programme(uuid, text, uuid) from public, anon;
grant execute on function public.can_manage_programme(uuid, text, uuid) to authenticated;

alter table public.development_programmes enable row level security;
alter table public.programme_members enable row level security;
alter table public.programme_checkins enable row level security;
revoke all on public.development_programmes, public.programme_members, public.programme_checkins from anon, authenticated;

-- Is the calling student in this audience? (safe wrapper for policies)
create or replace function public.i_am_in_target(p_inst uuid, p_grade text, p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.my_membership_id(p_inst) is not null and public.student_in_target(public.my_membership_id(p_inst), p_grade, p_class);
$$;
revoke execute on function public.i_am_in_target(uuid, text, uuid) from public, anon;
grant execute on function public.i_am_in_target(uuid, text, uuid) to authenticated;

drop policy if exists "read" on public.development_programmes;
create policy "read" on public.development_programmes for select to authenticated using (
  public.is_staff_role(public.inst_role(institution_id))
  or (public.inst_role(institution_id) = 'student' and public.i_am_in_target(institution_id, grade, class_id)));
drop policy if exists "insert" on public.development_programmes;
create policy "insert" on public.development_programmes for insert to authenticated
  with check (public.can_manage_programme(institution_id, grade, class_id));
drop policy if exists "update" on public.development_programmes;
create policy "update" on public.development_programmes for update to authenticated
  using (public.can_manage_programme(institution_id, grade, class_id))
  with check (public.can_manage_programme(institution_id, grade, class_id));
grant select, insert on public.development_programmes to authenticated;
grant update (title, description, category, grade, class_id, starts_on, ends_on, weekly_target, status) on public.development_programmes to authenticated;

-- Members and check-ins: the student, and staff who can see one of the student's classes or manage the programme.
create or replace function public.can_view_student(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.institution_memberships m
     where m.id = p_student
       and (m.user_id = auth.uid()
            or (public.is_staff_role(public.inst_role(m.institution_id))
                and (public.inst_role(m.institution_id) in ('principal', 'director')
                     or exists (select 1 from public.class_enrollments e where e.student_id = m.id and public.can_view_class(e.class_id))))));
$$;
revoke execute on function public.can_view_student(uuid) from public, anon;
grant execute on function public.can_view_student(uuid) to authenticated;

drop policy if exists "read" on public.programme_members;
create policy "read" on public.programme_members for select to authenticated using (public.can_view_student(student_id));
drop policy if exists "read" on public.programme_checkins;
create policy "read" on public.programme_checkins for select to authenticated using (public.can_view_student(student_id));
grant select on public.programme_members, public.programme_checkins to authenticated;

drop trigger if exists development_programmes_keep_inst on public.development_programmes;
create trigger development_programmes_keep_inst before update on public.development_programmes for each row execute function public.keep_institution_id();
drop trigger if exists development_programmes_audit on public.development_programmes;
create trigger development_programmes_audit after insert or update or delete on public.development_programmes for each row execute function public.audit_row_change();
drop trigger if exists development_programmes_updated_at on public.development_programmes;
create trigger development_programmes_updated_at before update on public.development_programmes for each row execute function public.set_updated_at();

create or replace function public.join_programme(p_programme uuid, p_join boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.development_programmes;
  me uuid;
begin
  select * into p from public.development_programmes where id = p_programme;
  if p.id is null then
    raise exception 'Programme not found.';
  end if;
  me := public.my_membership_id(p.institution_id);
  if me is null or public.inst_role(p.institution_id) <> 'student' or not public.student_in_target(me, p.grade, p.class_id) then
    raise exception 'This programme isn’t open to you.';
  end if;
  if p_join then
    if p.status <> 'active' or (p.ends_on is not null and p.ends_on < current_date) then
      raise exception 'This programme has ended.';
    end if;
    insert into public.programme_members (institution_id, programme_id, student_id) values (p.institution_id, p.id, me)
    on conflict (programme_id, student_id) do update set left_at = null, joined_at = case when public.programme_members.left_at is null then public.programme_members.joined_at else now() end;
  else
    update public.programme_members set left_at = now() where programme_id = p.id and student_id = me and left_at is null;
  end if;
end;
$$;
revoke execute on function public.join_programme(uuid, boolean) from public, anon;
grant execute on function public.join_programme(uuid, boolean) to authenticated;

-- One check-in per day, for today or the previous 6 days; p_remove undoes it.
create or replace function public.programme_checkin(p_programme uuid, p_day date default null, p_note text default null, p_remove boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.development_programmes;
  me uuid;
  today date;
  d date;
begin
  select * into p from public.development_programmes where id = p_programme;
  if p.id is null then
    raise exception 'Programme not found.';
  end if;
  me := public.my_membership_id(p.institution_id);
  if me is null or not exists (select 1 from public.programme_members m where m.programme_id = p.id and m.student_id = me and m.left_at is null) then
    raise exception 'Join the programme first.';
  end if;
  today := (now() at time zone (select timezone from public.institutions where id = p.institution_id))::date;
  d := coalesce(p_day, today);
  if d > today or d < today - 6 or d < p.starts_on or (p.ends_on is not null and d > p.ends_on) then
    raise exception 'You can check in for today or the last 6 days of the programme.';
  end if;
  if p_remove then
    delete from public.programme_checkins where programme_id = p.id and student_id = me and day = d;
  else
    insert into public.programme_checkins (institution_id, programme_id, student_id, day, note)
    values (p.institution_id, p.id, me, d, nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (programme_id, student_id, day) do update set note = excluded.note;
  end if;
end;
$$;
revoke execute on function public.programme_checkin(uuid, date, text, boolean) from public, anon;
grant execute on function public.programme_checkin(uuid, date, text, boolean) to authenticated;

-- Programmes with participation figures for the caller (students: open
-- programmes and their own progress; staff: member counts and check-in rate).
create or replace function public.programmes_overview(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  me uuid := public.my_membership_id(p_inst);
  today date := (now() at time zone (select timezone from public.institutions where id = p_inst))::date;
  week_start date := today - ((extract(isodow from today))::int - 1);
begin
  if r is null then
    raise exception 'Not a member of this institution.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'title', p.title, 'description', p.description, 'category', p.category, 'grade', p.grade,
      'class_id', p.class_id, 'class_name', (select c.name from public.classes c where c.id = p.class_id),
      'starts_on', p.starts_on, 'ends_on', p.ends_on, 'weekly_target', p.weekly_target, 'status', p.status,
      'can_manage', public.can_manage_programme(p_inst, p.grade, p.class_id),
      'joined', exists (select 1 from public.programme_members m where m.programme_id = p.id and m.student_id = me and m.left_at is null),
      'my_checkins_this_week', (select count(*) from public.programme_checkins k where k.programme_id = p.id and k.student_id = me and k.day >= week_start),
      'my_checked_in_today', exists (select 1 from public.programme_checkins k where k.programme_id = p.id and k.student_id = me and k.day = today),
      'members', case when r <> 'student' then (select count(*) from public.programme_members m where m.programme_id = p.id and m.left_at is null and public.can_view_student(m.student_id)) end,
      'checkin_rate_4w', case when r <> 'student' then (
        select round(avg(least(1.0, coalesce(x.n, 0)::numeric / (p.weekly_target * 4))), 3)
          from public.programme_members m
          left join lateral (select count(*) n from public.programme_checkins k where k.programme_id = p.id and k.student_id = m.student_id and k.day > today - 28) x on true
         where m.programme_id = p.id and m.left_at is null and public.can_view_student(m.student_id)) end
    ) order by p.status, p.starts_on desc, p.title)
    from public.development_programmes p
   where p.institution_id = p_inst
     and (r <> 'student' or (p.status = 'active' and public.student_in_target(me, p.grade, p.class_id)))
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.programmes_overview(uuid) from public, anon;
grant execute on function public.programmes_overview(uuid) to authenticated;

-- Members of one programme with their check-ins in the last 4 weeks (staff).
create or replace function public.programme_members_report(p_programme uuid)
returns table (student_id uuid, student text, class_name text, joined_at timestamptz, checkins_4w bigint, last_checkin date)
language sql
stable
security definer
set search_path = ''
as $$
  select m.student_id, s.display_name,
         (select string_agg(c.name, ', ' order by c.name) from public.class_enrollments e join public.classes c on c.id = e.class_id
           where e.student_id = m.student_id and not c.archived),
         m.joined_at,
         (select count(*) from public.programme_checkins k where k.programme_id = m.programme_id and k.student_id = m.student_id and k.day > current_date - 28),
         (select max(k.day) from public.programme_checkins k where k.programme_id = m.programme_id and k.student_id = m.student_id)
    from public.programme_members m
    join public.institution_memberships s on s.id = m.student_id
    join public.development_programmes p on p.id = m.programme_id
   where m.programme_id = p_programme and m.left_at is null
     and public.is_staff_role(public.inst_role(p.institution_id))
     and public.can_view_student(m.student_id)
   order by s.display_name;
$$;
revoke execute on function public.programme_members_report(uuid) from public, anon;
grant execute on function public.programme_members_report(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Development score
-- ---------------------------------------------------------------------
create table if not exists public.development_scores (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  student_id     uuid not null,
  period_from    date not null,
  period_to      date not null,
  score          numeric(3, 1) check (score is null or score between 1 and 10),
  insufficient   boolean not null,
  components     jsonb not null,
  weights        jsonb not null,
  calculated_by  uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  check (insufficient = (score is null)),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade
);
create index if not exists development_scores_student_idx on public.development_scores (student_id, created_at desc);
alter table public.development_scores enable row level security;
revoke all on public.development_scores from anon, authenticated;

-- Reports: the student; staff with view_reports who can see one of the student's classes (heads always).
create or replace function public.can_view_student_reports(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.institution_memberships m
     where m.id = p_student and m.role = 'student'
       and (m.user_id = auth.uid()
            or (public.is_staff_role(public.inst_role(m.institution_id))
                and public.has_inst_perm(m.institution_id, 'view_reports')
                and (public.inst_role(m.institution_id) in ('principal', 'director')
                     or exists (select 1 from public.class_enrollments e where e.student_id = m.id and public.can_view_class(e.class_id))))));
$$;
revoke execute on function public.can_view_student_reports(uuid) from public, anon;
grant execute on function public.can_view_student_reports(uuid) to authenticated;

drop policy if exists "read" on public.development_scores;
create policy "read" on public.development_scores for select to authenticated using (public.can_view_student_reports(student_id));
grant select on public.development_scores to authenticated;

-- The calculation itself (no permission checks; callers check). Returns
-- { score, insufficient, components: { key: { has_data, score 0–1, weight, detail } }, weights }.
create or replace function public.compute_development(p_student uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m        public.institution_memberships;
  w        jsonb;
  shares   boolean;
  comp     jsonb := '{}'::jsonb;
  n        integer;
  v        numeric;
  avg_pct  numeric;
  subjects jsonb;
  sched    integer;
  done     integer;
  max_day  integer;
  late     boolean;
  healthy  boolean;
  progs    integer;
  goals    integer;
  k        text;
  tw       numeric := 0;
  ws       numeric := 0;
  total_w  numeric := 0;
begin
  select * into m from public.institution_memberships where id = p_student;
  w := public.institution_settings(m.institution_id) -> 'development_weights';
  shares := coalesce((select p.share_habits_with_school from public.profiles p where p.id = m.user_id), false);

  -- Academic: published marks in the period (and 60 days before, so a term's tests count).
  select count(*), round(avg(k2.obtained / a.max_marks * 100), 1)
    into n, avg_pct
    from public.marks k2 join public.assessments a on a.id = k2.assessment_id
   where k2.student_id = p_student and a.status = 'published' and not k2.absent and k2.obtained is not null
     and a.assessment_date between p_from - 60 and p_to;
  select coalesce(jsonb_agg(jsonb_build_object('subject', x.name, 'pct', x.pct) order by x.pct), '[]'::jsonb) into subjects
    from (select sj.name, round(avg(k2.obtained / a.max_marks * 100), 1) pct
            from public.marks k2 join public.assessments a on a.id = k2.assessment_id join public.subjects sj on sj.id = a.subject_id
           where k2.student_id = p_student and a.status = 'published' and not k2.absent and k2.obtained is not null
             and a.assessment_date between p_from - 60 and p_to
           group by sj.name) x;
  comp := comp || jsonb_build_object('academic', jsonb_build_object(
    'has_data', n >= 2, 'score', case when n >= 2 then round(avg_pct / 100, 3) end,
    'detail', jsonb_build_object('marks', n, 'average_pct', avg_pct, 'grade', public.grade_for(m.institution_id, avg_pct), 'subjects', subjects)));

  -- Homework: work due in the period. On time 1, late 0.6, resubmission requested 0.5, rejected 0.2, missing 0.
  select count(*),
         avg(case when s.status is null or s.status = 'not_submitted' then 0
                  when s.status = 'rejected' then 0.2
                  when s.status = 'resubmission_requested' then 0.5
                  when s.is_late then 0.6 else 1 end)
    into n, v
    from public.assignments a
    join public.class_enrollments e on e.class_id = a.class_id and e.student_id = p_student
    left join public.submissions s on s.assignment_id = a.id and s.student_id = p_student
   where a.status in ('published', 'closed') and a.due_at < now() and a.due_at::date between p_from and p_to;
  comp := comp || jsonb_build_object('homework', jsonb_build_object(
    'has_data', n >= 3, 'score', case when n >= 3 then round(v, 3) end,
    'detail', jsonb_build_object('expected', n,
      'missing', (select count(*) from public.assignments a join public.class_enrollments e on e.class_id = a.class_id and e.student_id = p_student
                   left join public.submissions s on s.assignment_id = a.id and s.student_id = p_student
                  where a.status in ('published', 'closed') and a.due_at < now() and a.due_at::date between p_from and p_to
                    and (s.status is null or s.status = 'not_submitted')),
      'late', (select count(*) from public.submissions s join public.assignments a on a.id = s.assignment_id
                where s.student_id = p_student and s.is_late and a.due_at::date between p_from and p_to))));

  -- Attendance: present 1, late 0.75, excused not counted, anything else 0.
  select count(*) filter (where ar.status <> 'excused'),
         avg(case ar.status when 'present' then 1 when 'late' then 0.75 else 0 end) filter (where ar.status <> 'excused')
    into n, v
    from public.attendance_records ar
   where ar.student_id = p_student and ar.session_date between p_from and p_to;
  comp := comp || jsonb_build_object('attendance', jsonb_build_object(
    'has_data', n >= 10, 'score', case when n >= 10 then round(v, 3) end,
    'detail', jsonb_build_object('records', n,
      'absent', (select count(*) from public.attendance_records ar where ar.student_id = p_student and ar.session_date between p_from and p_to and ar.status = 'absent'),
      'late', (select count(*) from public.attendance_records ar where ar.student_id = p_student and ar.session_date between p_from and p_to and ar.status = 'late'))));

  -- Planning and habits: only if the student shares it. Scheduled task-days in
  -- the last 28 days of the period vs ticked; very long (> 6 h on a day) or
  -- late-night (after 23:00 / before 05:00) schedules are capped at 0.6.
  if shares then
    select coalesce(sum((select count(*) from public.tasks t where t.user_id = m.user_id and t.day_of_week = extract(dow from d)::int)), 0)
      into sched
      from generate_series(greatest(p_from, p_to - 27), p_to, interval '1 day') d;
    select count(*) into done from public.task_completions c
     where c.user_id = m.user_id and c.completed and c.completion_date between greatest(p_from, p_to - 27) and p_to;
    select coalesce(max(x.mins), 0) into max_day from (
      select t.tracker_id, t.day_of_week, sum(extract(epoch from (s.end_time - s.start_time)) / 60)::int mins
        from public.tasks t join public.time_slots s on s.id = t.time_slot_id
       where t.user_id = m.user_id group by t.tracker_id, t.day_of_week) x;
    select exists (select 1 from public.tasks t join public.time_slots s on s.id = t.time_slot_id
                    where t.user_id = m.user_id and (s.end_time > time '23:00' or s.start_time < time '05:00')) into late;
    healthy := max_day <= 360 and not late;
    v := case when sched > 0 then least(1, done::numeric / sched) end;
    if not healthy then
      v := least(v, 0.6);
    end if;
    comp := comp || jsonb_build_object('planning', jsonb_build_object(
      'has_data', sched >= 14, 'score', case when sched >= 14 then round(v, 3) end,
      'detail', jsonb_build_object('shared', true, 'scheduled', sched, 'completed', done, 'healthy', healthy,
                                   'longest_day_minutes', max_day, 'late_night', late)));
  else
    comp := comp || jsonb_build_object('planning', jsonb_build_object('has_data', false, 'score', null, 'detail', jsonb_build_object('shared', false)));
  end if;

  -- Extracurricular and skills: programme check-ins against each programme's
  -- weekly target over the weeks the student was a member (last 12 weeks),
  -- plus completed skill / extracurricular / health goals if shared (+0.1 each, max +0.3).
  select count(*), avg(least(1, x.n::numeric / greatest(1, x.target)))
    into progs, v
    from (
      select pm.programme_id,
             (select count(*) from public.programme_checkins k where k.programme_id = pm.programme_id and k.student_id = p_student
                and k.day between greatest(p_from, p_to - 83, pm.joined_at::date) and p_to) n,
             p.weekly_target * greatest(1, ceil((p_to - greatest(p_from, p_to - 83, pm.joined_at::date, p.starts_on) + 1) / 7.0)) target
        from public.programme_members pm join public.development_programmes p on p.id = pm.programme_id
       where pm.student_id = p_student and pm.joined_at::date <= p_to and (pm.left_at is null or pm.left_at::date >= p_from)) x;
  goals := case when shares then (select count(*) from public.student_goals g
                                   where g.user_id = m.user_id and g.status = 'completed' and g.category in ('skill', 'extracurricular', 'health')
                                     and g.completed_at::date between p_from and p_to) else 0 end;
  comp := comp || jsonb_build_object('extracurricular', jsonb_build_object(
    'has_data', progs > 0 or goals > 0,
    'score', case when progs > 0 or goals > 0 then round(least(1, coalesce(v, 0.3) + least(0.3, goals * 0.1)), 3) end,
    'detail', jsonb_build_object('programmes', progs, 'goals_completed', goals, 'goals_shared', shares)));

  -- Weighted result.
  for k in select jsonb_object_keys(w) loop
    total_w := total_w + (w ->> k)::numeric;
    comp := jsonb_set(comp, array[k, 'weight'], w -> k);
    if (comp -> k ->> 'has_data')::boolean and (w ->> k)::numeric > 0 then
      tw := tw + (w ->> k)::numeric;
      ws := ws + (w ->> k)::numeric * (comp -> k ->> 'score')::numeric;
    end if;
  end loop;
  return jsonb_build_object(
    'score', case when total_w > 0 and tw * 2 >= total_w then round(1 + 9 * ws / tw, 1) end,
    'insufficient', not (total_w > 0 and tw * 2 >= total_w),
    'covered_weight', tw,
    'components', comp,
    'weights', w);
end;
$$;
revoke execute on function public.compute_development(uuid, date, date) from public, anon, authenticated;

-- Calculates and records a student's score for the last p_days days.
-- A repeat within 10 minutes returns the stored result.
create or replace function public.calculate_development_score(p_student uuid, p_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m     public.institution_memberships;
  today date;
  d     integer := greatest(28, least(coalesce(p_days, 90), 366));
  res   jsonb;
  row   public.development_scores;
begin
  if not public.can_view_student_reports(p_student) then
    raise exception 'NOT_ALLOWED:You can’t see reports for this student.' using errcode = '42501';
  end if;
  select * into m from public.institution_memberships where id = p_student;
  today := (now() at time zone (select timezone from public.institutions where id = m.institution_id))::date;
  select * into row from public.development_scores s
   where s.student_id = p_student and s.period_to = today and s.period_from = today - d + 1 and s.created_at > now() - interval '10 minutes'
   order by s.created_at desc limit 1;
  if row.id is null then
    res := public.compute_development(p_student, today - d + 1, today);
    insert into public.development_scores (institution_id, student_id, period_from, period_to, score, insufficient, components, weights, calculated_by)
    values (m.institution_id, p_student, today - d + 1, today, (res ->> 'score')::numeric, (res ->> 'insufficient')::boolean,
            res -> 'components', res -> 'weights', auth.uid())
    returning * into row;
  end if;
  return to_jsonb(row) || jsonb_build_object('student', m.display_name);
end;
$$;
revoke execute on function public.calculate_development_score(uuid, integer) from public, anon;
grant execute on function public.calculate_development_score(uuid, integer) to authenticated;

-- Calculates every student of a class the caller can report on.
create or replace function public.calculate_class_development(p_class uuid, p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.classes;
  s uuid;
  n integer := 0;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not public.can_view_class(p_class) or not public.has_inst_perm(c.institution_id, 'view_reports')
     or not public.is_staff_role(public.inst_role(c.institution_id)) then
    raise exception 'NOT_ALLOWED:You can’t see reports for this class.' using errcode = '42501';
  end if;
  for s in select e.student_id from public.class_enrollments e join public.institution_memberships m on m.id = e.student_id
            where e.class_id = p_class and m.status = 'active' loop
    perform public.calculate_development_score(s, p_days);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.calculate_class_development(uuid, integer) from public, anon;
grant execute on function public.calculate_class_development(uuid, integer) to authenticated;

-- One class: each student's latest score and components plus attendance / homework / marks figures.
create or replace function public.class_report(p_class uuid, p_days integer default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c     public.classes;
  since date;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not public.can_view_class(p_class) or not public.has_inst_perm(c.institution_id, 'view_reports')
     or not public.is_staff_role(public.inst_role(c.institution_id)) then
    raise exception 'NOT_ALLOWED:You can’t see reports for this class.' using errcode = '42501';
  end if;
  since := (now() at time zone (select timezone from public.institutions where id = c.institution_id))::date - greatest(28, least(coalesce(p_days, 90), 366)) + 1;
  return jsonb_build_object(
    'class', c.name, 'grade', c.grade, 'since', since,
    'teacher', (select display_name from public.institution_memberships where id = c.class_teacher_id),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
        'student_id', m.id, 'name', m.display_name, 'external_id', m.external_id, 'roll_no', e.roll_no,
        'latest', (select jsonb_build_object('score', d.score, 'insufficient', d.insufficient, 'components', d.components, 'created_at', d.created_at)
                     from public.development_scores d where d.student_id = m.id order by d.created_at desc limit 1),
        'attendance_rate', (select round(avg(case ar.status when 'present' then 1 when 'late' then 0.75 else 0 end) filter (where ar.status <> 'excused'), 3)
                              from public.attendance_records ar where ar.student_id = m.id and ar.class_id = c.id and ar.session_date >= since),
        'homework_rate', (select round(avg(case when s.status is null or s.status = 'not_submitted' then 0 else 1 end), 3)
                            from public.assignments a left join public.submissions s on s.assignment_id = a.id and s.student_id = m.id
                           where a.class_id = c.id and a.status in ('published', 'closed') and a.due_at < now() and a.due_at::date >= since),
        'marks_pct', (select round(avg(k.obtained / a.max_marks * 100), 1) from public.marks k join public.assessments a on a.id = k.assessment_id
                       where k.student_id = m.id and a.class_id = c.id and a.status = 'published' and not k.absent and a.assessment_date >= since - 60)
      ) order by e.roll_no nulls last, m.display_name)
      from public.class_enrollments e join public.institution_memberships m on m.id = e.student_id
     where e.class_id = c.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.class_report(uuid, integer) from public, anon;
grant execute on function public.class_report(uuid, integer) to authenticated;

-- Weekly calculation for every active student of active institutions (pg_cron).
create or replace function public.development_weekly_job()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  res jsonb;
  today date;
  n integer := 0;
begin
  for m in select s.id, s.institution_id, i.timezone from public.institution_memberships s join public.institutions i on i.id = s.institution_id
            where s.role = 'student' and s.status = 'active' and i.status = 'active' loop
    today := (now() at time zone m.timezone)::date;
    if exists (select 1 from public.development_scores d where d.student_id = m.id and d.calculated_by is null and d.period_to = today) then
      continue;
    end if;
    res := public.compute_development(m.id, today - 89, today);
    insert into public.development_scores (institution_id, student_id, period_from, period_to, score, insufficient, components, weights, calculated_by)
    values (m.institution_id, m.id, today - 89, today, (res ->> 'score')::numeric, (res ->> 'insufficient')::boolean, res -> 'components', res -> 'weights', null);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.development_weekly_job() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('development-scores') where exists (select 1 from cron.job where jobname = 'development-scores');
    perform cron.schedule('development-scores', '15 2 * * 1', 'select public.development_weekly_job()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Exports (CSV is produced in the app). Only classes the caller can see;
-- needs import_export or view_reports.
-- ---------------------------------------------------------------------
create or replace function public.can_export(p_inst uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_staff_role(public.inst_role(p_inst))
     and (public.has_inst_perm(p_inst, 'import_export') or public.has_inst_perm(p_inst, 'view_reports'));
$$;
revoke execute on function public.can_export(uuid) from public, anon;
grant execute on function public.can_export(uuid) to authenticated;

create or replace function public.export_attendance(p_inst uuid, p_class uuid, p_from date, p_to date)
returns table (session_date date, class text, subject text, period smallint, student text, admission_no text, status text, note text, corrected text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_export(p_inst) or p_to - p_from > 400 then
    raise exception 'NOT_ALLOWED:You can’t export this.' using errcode = '42501';
  end if;
  return query
  select ar.session_date, c.name, sj.name, ar.period, m.display_name, m.external_id, ar.status, ar.note, ar.correction_reason
    from public.attendance_records ar
    join public.classes c on c.id = ar.class_id
    join public.institution_memberships m on m.id = ar.student_id
    left join public.subjects sj on sj.id = ar.subject_id
   where ar.institution_id = p_inst and ar.session_date between p_from and p_to
     and (p_class is null or ar.class_id = p_class) and public.can_view_class(ar.class_id)
   order by ar.session_date, c.name, ar.period, m.display_name;
end;
$$;

create or replace function public.export_marks(p_inst uuid, p_class uuid, p_from date, p_to date)
returns table (assessment_date date, class text, subject text, assessment text, kind text, status text, max_marks numeric,
               student text, admission_no text, obtained numeric, absent boolean, percentage numeric, grade text, feedback text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_export(p_inst) or p_to - p_from > 400 then
    raise exception 'NOT_ALLOWED:You can’t export this.' using errcode = '42501';
  end if;
  return query
  select a.assessment_date, c.name, sj.name, a.title, a.kind, a.status, a.max_marks, m.display_name, m.external_id,
         k.obtained, k.absent, case when k.absent or k.obtained is null then null else round(k.obtained / a.max_marks * 100, 1) end,
         case when k.absent or k.obtained is null then null else public.grade_for(p_inst, k.obtained / a.max_marks * 100) end, k.feedback
    from public.marks k
    join public.assessments a on a.id = k.assessment_id
    join public.classes c on c.id = a.class_id
    join public.subjects sj on sj.id = a.subject_id
    join public.institution_memberships m on m.id = k.student_id
   where a.institution_id = p_inst and a.assessment_date between p_from and p_to
     and (p_class is null or a.class_id = p_class) and public.can_view_class(a.class_id)
   order by a.assessment_date, c.name, sj.name, a.title, m.display_name;
end;
$$;

create or replace function public.export_assignments(p_inst uuid, p_class uuid, p_from date, p_to date)
returns table (class text, subject text, teacher text, title text, kind text, status text, opens_at timestamptz, due_at timestamptz,
               students bigint, submitted bigint, on_time bigint, accepted bigint, missing bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_export(p_inst) or p_to - p_from > 400 then
    raise exception 'NOT_ALLOWED:You can’t export this.' using errcode = '42501';
  end if;
  return query
  select c.name, sj.name, t.display_name, a.title, a.kind, a.status, a.opens_at, a.due_at,
         count(e.student_id),
         count(s.id) filter (where s.status <> 'not_submitted'),
         count(s.id) filter (where s.status <> 'not_submitted' and not s.is_late),
         count(s.id) filter (where s.status = 'accepted'),
         count(e.student_id) filter (where s.id is null or s.status = 'not_submitted')
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.subjects sj on sj.id = a.subject_id
    join public.institution_memberships t on t.id = a.teacher_id
    left join public.class_enrollments e on e.class_id = a.class_id
    left join public.submissions s on s.assignment_id = a.id and s.student_id = e.student_id
   where a.institution_id = p_inst and a.due_at::date between p_from and p_to
     and (p_class is null or a.class_id = p_class) and public.can_view_class(a.class_id)
   group by a.id, c.name, sj.name, t.display_name
   order by a.due_at, c.name;
end;
$$;

-- Latest development score per student (one row per student and class).
create or replace function public.export_development(p_inst uuid, p_class uuid)
returns table (class text, student text, admission_no text, calculated_at timestamptz, period_from date, period_to date, score numeric,
               insufficient boolean, academic numeric, homework numeric, attendance numeric, planning numeric, extracurricular numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_export(p_inst) or not public.has_inst_perm(p_inst, 'view_reports') then
    raise exception 'NOT_ALLOWED:You can’t export this.' using errcode = '42501';
  end if;
  return query
  select c.name, m.display_name, m.external_id, d.created_at, d.period_from, d.period_to, d.score, d.insufficient,
         (d.components -> 'academic' ->> 'score')::numeric, (d.components -> 'homework' ->> 'score')::numeric,
         (d.components -> 'attendance' ->> 'score')::numeric, (d.components -> 'planning' ->> 'score')::numeric,
         (d.components -> 'extracurricular' ->> 'score')::numeric
    from public.class_enrollments e
    join public.classes c on c.id = e.class_id
    join public.institution_memberships m on m.id = e.student_id
    left join lateral (select * from public.development_scores x where x.student_id = m.id order by x.created_at desc limit 1) d on true
   where e.institution_id = p_inst and not c.archived and (p_class is null or e.class_id = p_class) and public.can_view_class(e.class_id)
   order by c.name, m.display_name;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['export_attendance(uuid, uuid, date, date)', 'export_marks(uuid, uuid, date, date)',
                           'export_assignments(uuid, uuid, date, date)', 'export_development(uuid, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Exports are recorded in the audit log (what, not the data).
create or replace function public.log_export(p_inst uuid, p_kind text, p_rows integer, p_filters jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_export(p_inst) or p_kind !~ '^[a-z_]{2,30}$' then
    raise exception 'NOT_ALLOWED:You can’t export this.' using errcode = '42501';
  end if;
  insert into public.audit_log (institution_id, actor_id, action, record_type, new_value)
  values (p_inst, auth.uid(), 'export', 'export_' || p_kind, jsonb_build_object('rows', p_rows, 'filters', coalesce(p_filters, '{}'::jsonb)));
end;
$$;
revoke execute on function public.log_export(uuid, text, integer, jsonb) from public, anon;
grant execute on function public.log_export(uuid, text, integer, jsonb) to authenticated;

-- Class teachers may run programmes for their own class (can_manage_programme limits the audience).
create or replace function public.default_role_permissions(p_role text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'principal' then public.all_permissions()
    when 'director' then public.all_permissions()
    when 'coordinator' then array['manage_students', 'manage_classes', 'manage_calendar', 'approve_deadline_changes',
                                  'set_homework_retention', 'manage_programmes', 'view_reports', 'message_parents', 'manage_timetable']
    when 'class_teacher' then array['record_attendance', 'create_assignments', 'enter_marks', 'view_reports', 'message_parents',
                                    'manage_timetable', 'edit_student_timetables', 'manage_programmes']
    when 'subject_teacher' then array['record_attendance', 'create_assignments', 'enter_marks']
    else array[]::text[]
  end;
$$;
