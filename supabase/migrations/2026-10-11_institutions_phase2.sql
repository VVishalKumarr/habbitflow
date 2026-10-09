-- =====================================================================
-- Institutions — Phase 2: homework submissions and review, attendance,
-- internal/external marks, homework file retention, in-app notifications.
--
-- * Homework files live in the private "homework" bucket. There are no
--   storage policies for clients: uploads and downloads go through the
--   "homework" server function, which validates the file and asks the
--   functions below whether the caller may upload / read it. Downloads use
--   signed URLs that expire after 2 minutes.
-- * Attendance and marks are written only through record_attendance() and
--   save_marks(); corrections need a reason and the audit log keeps the
--   previous value.
-- * Retention: files become eligible for deletion review_retention_days
--   after the later of the deadline and the last upload (and, while a
--   resubmission is pending, after the request). Assignments on retention
--   hold are skipped. File deletion never deletes submission, review or
--   marks records.
-- Additive only. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings: whether teachers may mark work "rejected"
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
    'attendance_statuses', jsonb_build_array('present', 'absent', 'late', 'excused')
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
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'Unknown time zone.';
  end if;
  if jsonb_typeof(s) <> 'object' then
    raise exception 'Settings must be an object.';
  end if;
  for k in select jsonb_object_keys(s) loop
    if k not in ('homework_retention_days', 'max_deadlines_per_day', 'max_deadlines_per_week', 'grading_scale',
                 'attendance_statuses', 'allow_rejection') then
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
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- In-app notifications (email / push delivery is added in later phases)
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  institution_id uuid references public.institutions (id) on delete cascade,
  kind           text not null check (char_length(kind) between 1 and 40),
  title          text not null check (char_length(title) between 1 and 200),
  body           text check (body is null or char_length(body) <= 1000),
  link           text check (link is null or (link ~ '^/[A-Za-z0-9/_?=&.-]*$' and char_length(link) <= 300)),
  dedupe_key     text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  created_at     timestamptz not null default now(),
  read_at        timestamptz
);
create unique index if not exists notifications_dedupe_idx on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
drop policy if exists "own" on public.notifications;
create policy "own" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "mark read" on public.notifications;
create policy "mark read" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Internal: one notification, ignored if the same dedupe key was already sent.
create or replace function public.notify(p_user uuid, p_inst uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select p_user, p_inst, p_kind, left(p_title, 200), left(p_body, 1000), p_link, p_dedupe
  where p_user is not null
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Homework storage bucket (private, 4 MB, PDF/JPEG/PNG)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('homework', 'homework', false, 4194304, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = 4194304, allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];

-- ---------------------------------------------------------------------
-- Retention hold (exception workflow) on assignments
-- ---------------------------------------------------------------------
alter table public.assignments add column if not exists retention_hold boolean not null default false;
alter table public.assignments add column if not exists retention_hold_reason text;
do $$ begin
  alter table public.assignments add constraint assignments_hold_reason_check
    check (not retention_hold or char_length(btrim(coalesce(retention_hold_reason, ''))) between 3 and 500);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Submissions, files, reviews
-- ---------------------------------------------------------------------
create table if not exists public.submissions (
  id                 uuid primary key default gen_random_uuid(),
  institution_id     uuid not null references public.institutions (id) on delete cascade,
  assignment_id      uuid not null,
  student_id         uuid not null,
  status             text not null default 'not_submitted'
                     check (status in ('not_submitted', 'submitted', 'under_review', 'accepted', 'resubmission_requested', 'rejected')),
  attempt            smallint not null default 0 check (attempt between 0 and 20),
  first_submitted_at timestamptz,
  last_submitted_at  timestamptz,
  is_late            boolean not null default false,
  reviewed_at        timestamptz,
  reviewed_by        uuid references auth.users (id) on delete set null,
  feedback           text check (feedback is null or char_length(feedback) <= 4000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (assignment_id, student_id),
  unique (id, institution_id),
  foreign key (assignment_id, institution_id) references public.assignments (id, institution_id) on delete cascade,
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists submissions_student_idx on public.submissions (student_id);

create table if not exists public.submission_files (
  id              uuid primary key default gen_random_uuid(),
  institution_id  uuid not null references public.institutions (id) on delete cascade,
  submission_id   uuid not null,
  attempt         smallint not null,
  storage_path    text not null unique,
  file_name       text not null check (char_length(file_name) between 1 and 120),
  mime_type       text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes      integer not null check (size_bytes between 1 and 4194304),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at     timestamptz not null default now(),
  deleted_at      timestamptz,
  deletion_reason text,
  foreign key (submission_id, institution_id) references public.submissions (id, institution_id) on delete cascade
);
create index if not exists submission_files_sub_idx on public.submission_files (submission_id);
create index if not exists submission_files_live_idx on public.submission_files (uploaded_at) where deleted_at is null;

create table if not exists public.submission_reviews (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  submission_id  uuid not null,
  reviewer_id    uuid references auth.users (id) on delete set null,
  status         text not null check (status in ('under_review', 'accepted', 'resubmission_requested', 'rejected')),
  comment        text check (comment is null or char_length(comment) <= 4000),
  attempt        smallint not null,
  created_at     timestamptz not null default now(),
  foreign key (submission_id, institution_id) references public.submissions (id, institution_id) on delete cascade
);
create index if not exists submission_reviews_sub_idx on public.submission_reviews (submission_id, created_at);

-- Minimal record kept after a homework file is deleted.
create table if not exists public.homework_file_deletions (
  id                bigint generated always as identity primary key,
  institution_id    uuid not null,
  assignment_id     uuid not null,
  submission_id     uuid not null,
  file_id           uuid not null unique,
  submission_status text not null,
  due_at            timestamptz not null,
  review_deadline   timestamptz not null,
  scheduled_for     timestamptz not null,
  deleted_at        timestamptz not null default now(),
  reason            text not null
);
create index if not exists homework_deletions_inst_idx on public.homework_file_deletions (institution_id, deleted_at desc);

-- ---------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------
create table if not exists public.attendance_records (
  id                uuid primary key default gen_random_uuid(),
  institution_id    uuid not null references public.institutions (id) on delete cascade,
  class_id          uuid not null,
  subject_id        uuid,
  session_date      date not null,
  period            smallint not null default 0 check (period between 0 and 20),
  student_id        uuid not null,
  status            text not null check (status ~ '^[a-z_]{2,20}$'),
  note              text check (note is null or char_length(note) <= 300),
  recorded_by       uuid references auth.users (id) on delete set null,
  correction_reason text check (correction_reason is null or char_length(correction_reason) <= 500),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (class_id, institution_id) references public.classes (id, institution_id),
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create unique index if not exists attendance_unique_idx on public.attendance_records
  (class_id, session_date, period, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), student_id);
create index if not exists attendance_student_idx on public.attendance_records (student_id, session_date);

-- ---------------------------------------------------------------------
-- Assessments and marks
-- ---------------------------------------------------------------------
create table if not exists public.assessments (
  id              uuid primary key default gen_random_uuid(),
  institution_id  uuid not null references public.institutions (id) on delete cascade,
  class_id        uuid not null,
  subject_id      uuid not null,
  term_id         uuid,
  teacher_id      uuid not null,
  title           text not null check (char_length(btrim(title)) between 1 and 120),
  kind            text not null check (kind in ('internal', 'external', 'project', 'practical')),
  max_marks       numeric(7, 2) not null check (max_marks > 0 and max_marks <= 1000),
  assessment_date date not null,
  status          text not null default 'draft' check (status in ('draft', 'published')),
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, institution_id),
  foreign key (class_id, institution_id) references public.classes (id, institution_id),
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id),
  foreign key (term_id, institution_id) references public.terms (id, institution_id),
  foreign key (teacher_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists assessments_class_idx on public.assessments (class_id, assessment_date);

create table if not exists public.marks (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  assessment_id  uuid not null,
  student_id     uuid not null,
  obtained       numeric(7, 2) check (obtained is null or obtained >= 0),
  absent         boolean not null default false,
  feedback       text check (feedback is null or char_length(feedback) <= 2000),
  recorded_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (assessment_id, student_id),
  check (absent or obtained is not null),
  foreign key (assessment_id, institution_id) references public.assessments (id, institution_id) on delete cascade,
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists marks_student_idx on public.marks (student_id);

-- Obtained marks never exceed the maximum; the maximum can't drop below existing marks.
create or replace function public.check_marks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mx numeric;
begin
  if tg_table_name = 'marks' then
    select max_marks into mx from public.assessments where id = new.assessment_id;
    if new.obtained is not null and new.obtained > mx then
      raise exception 'Marks can’t be more than the maximum (%).', mx;
    end if;
  elsif new.max_marks < old.max_marks
        and exists (select 1 from public.marks m where m.assessment_id = new.id and m.obtained > new.max_marks) then
    raise exception 'Some students already have more marks than the new maximum.';
  end if;
  return new;
end;
$$;
drop trigger if exists marks_check on public.marks;
create trigger marks_check before insert or update on public.marks for each row execute function public.check_marks();
drop trigger if exists assessments_check on public.assessments;
create trigger assessments_check before update on public.assessments for each row execute function public.check_marks();

-- ---------------------------------------------------------------------
-- Triggers: updated_at, institution pinning, audit
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['submissions', 'attendance_records', 'assessments', 'marks'] loop
    execute format('drop trigger if exists %1$s_updated_at on public.%1$I', t);
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['submissions', 'submission_files', 'submission_reviews', 'attendance_records', 'assessments', 'marks'] loop
    execute format('drop trigger if exists %1$s_keep_inst on public.%1$I', t);
    execute format('create trigger %1$s_keep_inst before update on public.%1$I for each row execute function public.keep_institution_id()', t);
    execute format('drop trigger if exists %1$s_audit on public.%1$I', t);
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$I for each row execute function public.audit_row_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------
-- Teachers of the assignment's class+subject, its own teacher, heads and in-scope coordinators.
create or replace function public.can_review_assignment_for(p_user uuid, p_assignment uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.assignments;
  r text;
  me uuid;
  g text;
begin
  select * into a from public.assignments where id = p_assignment;
  if a.id is null then
    return false;
  end if;
  r := public.inst_role_for(p_user, a.institution_id);
  if r is null or not public.is_staff_role(r) then
    return false;
  end if;
  if r in ('principal', 'director') then
    return true;
  end if;
  select m.id into me from public.institution_memberships m
   where m.institution_id = a.institution_id and m.user_id = p_user and m.status = 'active';
  if a.teacher_id = me or exists (select 1 from public.teaching_assignments t
                                  where t.class_id = a.class_id and t.subject_id = a.subject_id and t.teacher_id = me) then
    return true;
  end if;
  if r = 'coordinator' then
    select c.grade into g from public.classes c where c.id = a.class_id;
    return exists (select 1 from public.coordinator_scopes s where s.coordinator_id = me and (s.grade = '*' or lower(s.grade) = lower(g)));
  end if;
  return false;
end;
$$;
revoke execute on function public.can_review_assignment_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_review_assignment(p_assignment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_review_assignment_for(auth.uid(), p_assignment);
$$;
revoke execute on function public.can_review_assignment(uuid) from public, anon;
grant execute on function public.can_review_assignment(uuid) to authenticated;

-- A student sees their own submission; staff who can see the class see its submissions.
create or replace function public.can_view_submission(p_submission uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.id = p_submission
      and (s.student_id = public.my_membership_id(s.institution_id)
           or (public.is_staff_role(public.inst_role(s.institution_id)) and public.can_view_class(a.class_id)))
  );
$$;
revoke execute on function public.can_view_submission(uuid) from public, anon;
grant execute on function public.can_view_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security (reads only; all writes go through functions)
-- ---------------------------------------------------------------------
alter table public.submissions             enable row level security;
alter table public.submission_files        enable row level security;
alter table public.submission_reviews      enable row level security;
alter table public.homework_file_deletions enable row level security;
alter table public.attendance_records      enable row level security;
alter table public.assessments             enable row level security;
alter table public.marks                   enable row level security;
revoke all on public.submissions, public.submission_files, public.submission_reviews, public.homework_file_deletions,
  public.attendance_records, public.assessments, public.marks from anon, authenticated;

drop policy if exists "read" on public.submissions;
create policy "read" on public.submissions for select to authenticated using (public.can_view_submission(id));
grant select on public.submissions to authenticated;

drop policy if exists "read" on public.submission_files;
create policy "read" on public.submission_files for select to authenticated using (public.can_view_submission(submission_id));
grant select (id, institution_id, submission_id, attempt, file_name, mime_type, size_bytes, uploaded_at, deleted_at, deletion_reason)
  on public.submission_files to authenticated;

drop policy if exists "read" on public.submission_reviews;
create policy "read" on public.submission_reviews for select to authenticated using (public.can_view_submission(submission_id));
grant select on public.submission_reviews to authenticated;

drop policy if exists "read" on public.homework_file_deletions;
create policy "read" on public.homework_file_deletions for select to authenticated
  using (public.has_inst_perm(institution_id, 'set_homework_retention') or public.has_inst_perm(institution_id, 'view_audit'));
grant select on public.homework_file_deletions to authenticated;

drop policy if exists "read" on public.attendance_records;
create policy "read" on public.attendance_records for select to authenticated
  using (student_id = public.my_membership_id(institution_id)
         or (public.is_staff_role(public.inst_role(institution_id)) and public.can_view_class(class_id)));
grant select on public.attendance_records to authenticated;

-- assessments: staff who can see the class; students only published ones of their class.
drop policy if exists "read" on public.assessments;
create policy "read" on public.assessments for select to authenticated
  using (public.can_view_class(class_id)
         and (status = 'published' or public.is_staff_role(public.inst_role(institution_id))));
drop policy if exists "insert" on public.assessments;
create policy "insert" on public.assessments for insert to authenticated
  with check (public.has_inst_perm(institution_id, 'enter_marks') and teacher_id = public.my_membership_id(institution_id)
              and public.teaches(class_id, subject_id) and status = 'draft');
drop policy if exists "update" on public.assessments;
create policy "update" on public.assessments for update to authenticated
  using (public.has_inst_perm(institution_id, 'enter_marks') and public.teaches(class_id, subject_id))
  with check (public.has_inst_perm(institution_id, 'enter_marks') and public.teaches(class_id, subject_id));
grant select on public.assessments to authenticated;
grant insert (institution_id, class_id, subject_id, term_id, teacher_id, title, kind, max_marks, assessment_date, status)
  on public.assessments to authenticated;
grant update (term_id, title, kind, max_marks, assessment_date) on public.assessments to authenticated;

drop policy if exists "read" on public.marks;
create policy "read" on public.marks for select to authenticated
  using (exists (
    select 1 from public.assessments a where a.id = assessment_id
      and ((public.is_staff_role(public.inst_role(a.institution_id)) and public.can_view_class(a.class_id))
           or (a.status = 'published' and student_id = public.my_membership_id(a.institution_id)))
  ));
grant select on public.marks to authenticated;

-- ---------------------------------------------------------------------
-- Homework upload (server function only)
-- ---------------------------------------------------------------------
-- Checks that p_actor may upload to the assignment now, creates the
-- submission row if needed and returns what the upload needs.
create or replace function public.homework_upload_check(p_actor uuid, p_assignment uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.assignments;
  me public.institution_memberships;
  s public.submissions;
  late boolean;
  attempt_no smallint;
  files_now integer;
begin
  select * into a from public.assignments where id = p_assignment;
  if a.id is null then
    raise exception 'Assignment not found.';
  end if;
  select m.* into me from public.institution_memberships m join public.institutions i on i.id = m.institution_id
   where m.institution_id = a.institution_id and m.user_id = p_actor and m.status = 'active' and i.status = 'active';
  if me.id is null or me.role <> 'student'
     or not exists (select 1 from public.class_enrollments e where e.class_id = a.class_id and e.student_id = me.id) then
    raise exception 'Assignment not found.';
  end if;
  if a.status <> 'published' then
    raise exception 'This assignment isn''t open for submissions.';
  end if;
  if now() < a.opens_at then
    raise exception 'Submissions open on %.', to_char(a.opens_at at time zone (select timezone from public.institutions where id = a.institution_id), 'DD Mon YYYY HH24:MI');
  end if;
  late := now() > a.due_at;
  if late and a.late_policy = 'reject' then
    raise exception 'The deadline has passed and late submissions aren''t accepted for this assignment.';
  end if;

  perform set_config('habitflow.actor', p_actor::text, true);
  insert into public.submissions (institution_id, assignment_id, student_id)
  values (a.institution_id, a.id, me.id)
  on conflict (assignment_id, student_id) do nothing;
  select * into s from public.submissions where assignment_id = a.id and student_id = me.id for update;

  if s.status in ('accepted', 'rejected') then
    raise exception 'Your teacher has already reviewed this work (%).', replace(s.status, '_', ' ');
  end if;
  if s.status = 'under_review' then
    raise exception 'Your teacher is reviewing this submission. You can upload again if they ask for a resubmission.';
  end if;
  attempt_no := case when s.status = 'resubmission_requested' or s.attempt = 0 then s.attempt + 1 else s.attempt end;
  select count(*) into files_now from public.submission_files f where f.submission_id = s.id and f.attempt = attempt_no;
  if files_now >= 5 then
    raise exception 'You can upload at most 5 files per submission.';
  end if;
  return jsonb_build_object(
    'submission_id', s.id, 'institution_id', a.institution_id, 'assignment_id', a.id, 'student_id', me.id,
    'attempt', attempt_no, 'late', late, 'allowed_types', to_jsonb(a.allowed_types), 'max_file_mb', a.max_file_mb
  );
end;
$$;
revoke execute on function public.homework_upload_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.homework_upload_check(uuid, uuid) to service_role;

-- Records an uploaded file (after the server function stored it) and marks
-- the work submitted. Re-runs the same checks.
create or replace function public.homework_record_file(
  p_actor uuid, p_assignment uuid, p_path text, p_name text, p_mime text, p_size integer, p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c jsonb := public.homework_upload_check(p_actor, p_assignment);
  sid uuid := (c ->> 'submission_id')::uuid;
  fid uuid;
  a public.assignments;
begin
  if p_path !~ ('^' || (c ->> 'institution_id') || '/' || p_assignment::text || '/' || (c ->> 'student_id') || '/[0-9a-f-]{36}\.(pdf|jpg|png)$') then
    raise exception 'Invalid storage path.';
  end if;
  insert into public.submission_files (institution_id, submission_id, attempt, storage_path, file_name, mime_type, size_bytes, sha256)
  values ((c ->> 'institution_id')::uuid, sid, (c ->> 'attempt')::smallint, p_path, left(p_name, 120), p_mime, p_size, p_sha256)
  returning id into fid;
  update public.submissions
     set status = 'submitted',
         attempt = (c ->> 'attempt')::smallint,
         first_submitted_at = coalesce(first_submitted_at, now()),
         last_submitted_at = now(),
         is_late = is_late or (c ->> 'late')::boolean
   where id = sid;
  select * into a from public.assignments where id = p_assignment;
  -- Confirmation for the student (one per attempt).
  perform public.notify(p_actor, a.institution_id, 'submission_received', 'Submission received: ' || a.title,
    case when (c ->> 'late')::boolean then 'Submitted after the deadline (marked late).' else 'Your teacher will review it.' end,
    '/school/assignments', 'submitted:' || sid || ':' || (c ->> 'attempt'));
  return jsonb_build_object('file_id', fid, 'submission_id', sid, 'late', (c ->> 'late')::boolean, 'attempt', (c ->> 'attempt')::int);
end;
$$;
revoke execute on function public.homework_record_file(uuid, uuid, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.homework_record_file(uuid, uuid, text, text, text, integer, text) to service_role;

-- Storage path of a file the actor may open (student owner or reviewer), or null.
create or replace function public.homework_file_path(p_actor uuid, p_file uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select f.storage_path
  from public.submission_files f
  join public.submissions s on s.id = f.submission_id
  join public.institution_memberships m on m.id = s.student_id
  where f.id = p_file and f.deleted_at is null
    and ((m.user_id = p_actor and m.status = 'active' and public.inst_role_for(p_actor, s.institution_id) = 'student')
         or public.can_review_assignment_for(p_actor, s.assignment_id));
$$;
revoke execute on function public.homework_file_path(uuid, uuid) from public, anon, authenticated;
grant execute on function public.homework_file_path(uuid, uuid) to service_role;

-- Students may remove a file before the work is reviewed (the object is
-- deleted by the server function).
create or replace function public.homework_remove_file(p_actor uuid, p_file uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.submission_files;
  s public.submissions;
begin
  select * into f from public.submission_files where id = p_file for update;
  select * into s from public.submissions where id = f.submission_id for update;
  if f.id is null or f.deleted_at is not null
     or not exists (select 1 from public.institution_memberships m where m.id = s.student_id and m.user_id = p_actor and m.status = 'active') then
    raise exception 'File not found.';
  end if;
  if s.status <> 'submitted' or f.attempt <> s.attempt then
    raise exception 'Files can only be removed before your teacher starts reviewing.';
  end if;
  perform set_config('habitflow.actor', p_actor::text, true);
  update public.submission_files set deleted_at = now(), deletion_reason = 'removed by student' where id = f.id;
  if not exists (select 1 from public.submission_files x where x.submission_id = s.id and x.attempt = s.attempt and x.deleted_at is null) then
    update public.submissions
       set status = case when s.attempt > 1 then 'resubmission_requested' else 'not_submitted' end,
           attempt = case when s.attempt > 1 then s.attempt - 1 else 0 end
     where id = s.id;
  end if;
  return f.storage_path;
end;
$$;
revoke execute on function public.homework_remove_file(uuid, uuid) from public, anon, authenticated;
grant execute on function public.homework_remove_file(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------
create or replace function public.review_submission(p_submission uuid, p_status text, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.submissions;
  a public.assignments;
  student_user uuid;
  label text;
begin
  select * into s from public.submissions where id = p_submission for update;
  if s.id is null or not public.can_review_assignment(s.assignment_id) then
    raise exception 'Submission not found.';
  end if;
  if p_status not in ('under_review', 'accepted', 'resubmission_requested', 'rejected') then
    raise exception 'Invalid review status.';
  end if;
  if s.status = 'not_submitted' then
    raise exception 'Nothing has been submitted yet.';
  end if;
  if p_status = 'rejected' and not (public.institution_settings(s.institution_id) ->> 'allow_rejection')::boolean then
    raise exception 'Your institution doesn''t allow rejecting work. Request a resubmission instead.';
  end if;
  if p_status in ('resubmission_requested', 'rejected') and char_length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Tell the student what to change (at least 3 characters).';
  end if;
  if p_status = 'resubmission_requested' and s.attempt >= 20 then
    raise exception 'This work has been resubmitted too many times.';
  end if;
  select * into a from public.assignments where id = s.assignment_id;
  insert into public.submission_reviews (institution_id, submission_id, reviewer_id, status, comment, attempt)
  values (s.institution_id, s.id, auth.uid(), p_status, nullif(btrim(coalesce(p_comment, '')), ''), s.attempt);
  update public.submissions
     set status = p_status, reviewed_at = now(), reviewed_by = auth.uid(),
         feedback = coalesce(nullif(btrim(coalesce(p_comment, '')), ''), feedback)
   where id = s.id;

  if p_status <> 'under_review' then
    select user_id into student_user from public.institution_memberships where id = s.student_id;
    label := case p_status when 'accepted' then 'accepted' when 'rejected' then 'not accepted' else 'needs changes' end;
    perform public.notify(student_user, s.institution_id, 'submission_reviewed', a.title || ': ' || label,
      coalesce(nullif(btrim(coalesce(p_comment, '')), ''), 'Your teacher reviewed your work.'), '/school/assignments',
      'review:' || s.id || ':' || s.attempt || ':' || p_status);
  end if;
end;
$$;
revoke execute on function public.review_submission(uuid, text, text) from public, anon;
grant execute on function public.review_submission(uuid, text, text) to authenticated;

-- Retention exception: keep an assignment's files past the interval (e.g. an appeal).
create or replace function public.set_retention_hold(p_assignment uuid, p_hold boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.assignments;
begin
  select * into a from public.assignments where id = p_assignment for update;
  if a.id is null or not public.has_inst_perm(a.institution_id, 'set_homework_retention') or not public.can_view_class(a.class_id) then
    raise exception 'Assignment not found.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason (at least 3 characters).';
  end if;
  perform set_config('habitflow.audit_reason', p_reason, true);
  update public.assignments set retention_hold = p_hold, retention_hold_reason = case when p_hold then btrim(p_reason) end
   where id = a.id;
end;
$$;
revoke execute on function public.set_retention_hold(uuid, boolean, text) from public, anon;
grant execute on function public.set_retention_hold(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Retention job (called by the homework-retention server function)
-- ---------------------------------------------------------------------
-- When a file may be deleted: retention days after the later of the deadline,
-- the last upload, and (while a resubmission is pending) the request.
create or replace function public.homework_delete_after(a public.assignments, s public.submissions)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(a.due_at, coalesce(s.last_submitted_at, a.due_at),
                  case when s.status = 'resubmission_requested' then coalesce(s.reviewed_at, a.due_at) else a.due_at end)
         + make_interval(days => a.review_retention_days);
$$;

create or replace function public.homework_retention_candidates(p_limit integer default 200)
returns table (file_id uuid, storage_path text, scheduled_for timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.storage_path, public.homework_delete_after(a, s)
  from public.submission_files f
  join public.submissions s on s.id = f.submission_id
  join public.assignments a on a.id = s.assignment_id
  where f.deleted_at is null and not a.retention_hold
    and public.homework_delete_after(a, s) <= now()
  order by f.uploaded_at
  limit greatest(1, least(p_limit, 1000));
$$;
revoke execute on function public.homework_retention_candidates(integer) from public, anon, authenticated;
grant execute on function public.homework_retention_candidates(integer) to service_role;

-- Marks files deleted after their objects were removed. Idempotent: files
-- already marked are skipped; files no longer eligible (e.g. put on hold
-- meanwhile) are skipped too.
create or replace function public.homework_mark_deleted(p_files uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  r record;
begin
  for r in
    select f.id as fid, f.submission_id, s.status, a.id as aid, a.institution_id, a.due_at, public.homework_delete_after(a, s) as sched
    from public.submission_files f
    join public.submissions s on s.id = f.submission_id
    join public.assignments a on a.id = s.assignment_id
    where f.id = any (p_files) and f.deleted_at is null
    for update of f
  loop
    update public.submission_files set deleted_at = now(), deletion_reason = left(p_reason, 200) where id = r.fid;
    insert into public.homework_file_deletions
      (institution_id, assignment_id, submission_id, file_id, submission_status, due_at, review_deadline, scheduled_for, reason)
    values (r.institution_id, r.aid, r.submission_id, r.fid, r.status, r.due_at, r.sched, r.sched, left(p_reason, 200))
    on conflict (file_id) do nothing;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.homework_mark_deleted(uuid[], text) from public, anon, authenticated;
grant execute on function public.homework_mark_deleted(uuid[], text) to service_role;

-- ---------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------
create or replace function public.can_record_attendance(p_class uuid, p_subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.classes;
  me uuid;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not public.has_inst_perm(c.institution_id, 'record_attendance') then
    return false;
  end if;
  if public.inst_role(c.institution_id) in ('principal', 'director') then
    return true;
  end if;
  me := public.my_membership_id(c.institution_id);
  return c.class_teacher_id = me
      or (p_subject is not null and exists (select 1 from public.teaching_assignments t
                                            where t.class_id = c.id and t.subject_id = p_subject and t.teacher_id = me));
end;
$$;
revoke execute on function public.can_record_attendance(uuid, uuid) from public, anon;
grant execute on function public.can_record_attendance(uuid, uuid) to authenticated;

-- p_entries: [{ "student_id": uuid, "status": "present", "note": "…" }]
-- Changing an existing status needs p_reason (kept in the audit log with the old value).
create or replace function public.record_attendance(
  p_class uuid, p_subject uuid, p_date date, p_period integer, p_entries jsonb, p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.classes;
  allowed jsonb;
  e jsonb;
  st text;
  sid uuid;
  existing public.attendance_records;
  n integer := 0;
  today date;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not public.can_record_attendance(p_class, p_subject) then
    raise exception 'You can’t record attendance for this class.';
  end if;
  today := (now() at time zone (select timezone from public.institutions where id = c.institution_id))::date;
  if p_date is null or p_date > today then
    raise exception 'Attendance can’t be recorded for a future date.';
  end if;
  if p_date < today - 366 then
    raise exception 'That date is too far in the past.';
  end if;
  if coalesce(p_period, 0) not between 0 and 20 then
    raise exception 'Invalid period.';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 500 then
    raise exception 'Invalid attendance list.';
  end if;
  allowed := public.institution_settings(c.institution_id) -> 'attendance_statuses';
  if char_length(btrim(coalesce(p_reason, ''))) >= 3 then
    perform set_config('habitflow.audit_reason', p_reason, true);
  end if;

  for e in select * from jsonb_array_elements(p_entries) loop
    st := e ->> 'status';
    sid := (e ->> 'student_id')::uuid;
    if not allowed ? st then
      raise exception 'Unknown attendance status: %', st;
    end if;
    if not exists (select 1 from public.class_enrollments x where x.class_id = p_class and x.student_id = sid) then
      raise exception 'A student in the list isn''t enrolled in this class.';
    end if;
    select * into existing from public.attendance_records r
     where r.class_id = p_class and r.session_date = p_date and r.period = coalesce(p_period, 0)
       and coalesce(r.subject_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_subject, '00000000-0000-0000-0000-000000000000'::uuid)
       and r.student_id = sid
     for update;
    if existing.id is null then
      insert into public.attendance_records (institution_id, class_id, subject_id, session_date, period, student_id, status, note, recorded_by)
      values (c.institution_id, p_class, p_subject, p_date, coalesce(p_period, 0), sid, st, nullif(left(e ->> 'note', 300), ''), auth.uid());
      n := n + 1;
    elsif existing.status <> st or coalesce(existing.note, '') <> coalesce(left(e ->> 'note', 300), '') then
      if char_length(btrim(coalesce(p_reason, ''))) < 3 then
        raise exception 'CORRECTION_REASON_REQUIRED: Changing recorded attendance needs a reason.';
      end if;
      update public.attendance_records
         set status = st, note = nullif(left(e ->> 'note', 300), ''), recorded_by = auth.uid(), correction_reason = btrim(p_reason)
       where id = existing.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.record_attendance(uuid, uuid, date, integer, jsonb, text) from public, anon;
grant execute on function public.record_attendance(uuid, uuid, date, integer, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- Marks
-- ---------------------------------------------------------------------
-- p_entries: [{ "student_id": uuid, "obtained": 42.5 | null, "absent": false, "feedback": "…" }]
-- Once published, changes need p_reason; previous values stay in the audit log.
create or replace function public.save_marks(p_assessment uuid, p_entries jsonb, p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.assessments;
  e jsonb;
  sid uuid;
  v_got numeric;
  v_absent boolean;
  v_fb text;
  existing public.marks;
  n integer := 0;
  student_user uuid;
begin
  select * into a from public.assessments where id = p_assessment for update;
  if a.id is null or not public.has_inst_perm(a.institution_id, 'enter_marks') or not public.teaches(a.class_id, a.subject_id) then
    raise exception 'You can’t enter marks for this assessment.';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 500 then
    raise exception 'Invalid marks list.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) >= 3 then
    perform set_config('habitflow.audit_reason', p_reason, true);
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    sid := (e ->> 'student_id')::uuid;
    v_absent := coalesce((e ->> 'absent')::boolean, false);
    v_got := case when v_absent or e ->> 'obtained' is null or e ->> 'obtained' = '' then null else (e ->> 'obtained')::numeric end;
    v_fb := nullif(btrim(left(coalesce(e ->> 'feedback', ''), 2000)), '');
    if not exists (select 1 from public.class_enrollments x where x.class_id = a.class_id and x.student_id = sid) then
      raise exception 'A student in the list isn''t enrolled in this class.';
    end if;
    if v_got is not null and (v_got < 0 or v_got > a.max_marks) then
      raise exception 'Marks must be between 0 and %.', a.max_marks;
    end if;
    if v_got is null and not v_absent then
      continue; -- blank = not entered yet
    end if;
    select * into existing from public.marks where assessment_id = a.id and student_id = sid for update;
    if existing.id is null then
      insert into public.marks (institution_id, assessment_id, student_id, obtained, absent, feedback, recorded_by)
      values (a.institution_id, a.id, sid, v_got, v_absent, v_fb, auth.uid());
      n := n + 1;
    elsif existing.obtained is distinct from v_got or existing.absent <> v_absent or existing.feedback is distinct from v_fb then
      if a.status = 'published' and char_length(btrim(coalesce(p_reason, ''))) < 3 then
        raise exception 'CORRECTION_REASON_REQUIRED: Changing published marks needs a reason.';
      end if;
      update public.marks set obtained = v_got, absent = v_absent, feedback = v_fb, recorded_by = auth.uid() where id = existing.id;
      n := n + 1;
      if a.status = 'published' then
        select user_id into student_user from public.institution_memberships where id = sid;
        perform public.notify(student_user, a.institution_id, 'marks_corrected', 'Marks updated: ' || a.title,
          'Your teacher corrected your marks.', '/school/marks', 'marks-fix:' || existing.id || ':' || extract(epoch from now())::bigint);
      end if;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.save_marks(uuid, jsonb, text) from public, anon;
grant execute on function public.save_marks(uuid, jsonb, text) to authenticated;

create or replace function public.publish_assessment(p_assessment uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.assessments;
  n integer := 0;
  r record;
begin
  select * into a from public.assessments where id = p_assessment for update;
  if a.id is null or not public.has_inst_perm(a.institution_id, 'enter_marks') or not public.teaches(a.class_id, a.subject_id) then
    raise exception 'You can’t publish this assessment.';
  end if;
  if a.status = 'published' then
    return 0;
  end if;
  update public.assessments set status = 'published', published_at = now() where id = a.id;
  for r in select m.user_id from public.marks k join public.institution_memberships m on m.id = k.student_id where k.assessment_id = a.id loop
    perform public.notify(r.user_id, a.institution_id, 'marks_published', 'New marks: ' || a.title,
      'Your marks and feedback are available.', '/school/marks', 'marks:' || a.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.publish_assessment(uuid) from public, anon;
grant execute on function public.publish_assessment(uuid) to authenticated;

-- Grade label for a percentage using the institution's scale.
create or replace function public.grade_for(p_inst uuid, p_pct numeric)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select g ->> 'label'
  from jsonb_array_elements(public.institution_settings(p_inst) -> 'grading_scale') g
  where (g ->> 'min')::numeric <= p_pct
  order by (g ->> 'min')::numeric desc
  limit 1;
$$;
revoke execute on function public.grade_for(uuid, numeric) from public, anon;
grant execute on function public.grade_for(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- Dashboards: real attendance / homework / marks figures (null = no data)
-- ---------------------------------------------------------------------
create or replace function public.academic_summary(p_inst uuid, p_class uuid default null, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  me uuid := public.my_membership_id(p_inst);
  since date;
  att jsonb;
  hw jsonb;
  mk jsonb;
begin
  if r is null then
    raise exception 'Not a member of this institution.';
  end if;
  since := (now() at time zone (select timezone from public.institutions where id = p_inst))::date - greatest(1, least(p_days, 366));

  with recs as (
    select ar.status from public.attendance_records ar
    where ar.institution_id = p_inst and ar.session_date >= since
      and (p_class is null or ar.class_id = p_class)
      and (case when r = 'student' then ar.student_id = me else public.can_view_class(ar.class_id) end)
  )
  select jsonb_build_object('records', count(*),
           'present_rate', round(avg(case when status in ('present', 'late') then 1.0 else 0 end), 4),
           'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from recs group by status) x), '{}'::jsonb))
    into att from recs;

  with expected as (
    select a.id, e.student_id from public.assignments a
    join public.class_enrollments e on e.class_id = a.class_id
    where a.institution_id = p_inst and a.status in ('published', 'closed')
      and a.due_at < now() and a.due_at >= since
      and (p_class is null or a.class_id = p_class)
      and (case when r = 'student' then e.student_id = me else public.can_view_class(a.class_id) end)
  )
  select jsonb_build_object('expected', count(*),
           'submitted', count(*) filter (where s.status not in ('not_submitted') and s.status is not null),
           'on_time', count(*) filter (where s.status is not null and s.status <> 'not_submitted' and not s.is_late),
           'accepted', count(*) filter (where s.status = 'accepted'),
           'completion_rate', case when count(*) = 0 then null
                              else round((count(*) filter (where s.status is not null and s.status <> 'not_submitted'))::numeric / count(*), 4) end)
    into hw
  from expected x left join public.submissions s on s.assignment_id = x.id and s.student_id = x.student_id;

  select jsonb_build_object('marks', count(*), 'average_pct', round(avg(k.obtained / a.max_marks * 100), 1))
    into mk
  from public.marks k join public.assessments a on a.id = k.assessment_id
  where a.institution_id = p_inst and not k.absent and k.obtained is not null
    and a.assessment_date >= since - 60
    and (p_class is null or a.class_id = p_class)
    and (case when r = 'student' then a.status = 'published' and k.student_id = me else public.can_view_class(a.class_id) end);

  return jsonb_build_object('since', since, 'attendance', att, 'homework', hw, 'marks', mk);
end;
$$;
revoke execute on function public.academic_summary(uuid, uuid, integer) from public, anon;
grant execute on function public.academic_summary(uuid, uuid, integer) to authenticated;

-- Submission counts per assignment for the deadline calendar.
create or replace function public.assignment_progress(p_assignments uuid[])
returns table (assignment_id uuid, enrolled integer, submitted integer, late integer, accepted integer, needs_changes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id,
    (select count(*) from public.class_enrollments e where e.class_id = a.class_id)::integer,
    (select count(*) from public.submissions s where s.assignment_id = a.id and s.status <> 'not_submitted')::integer,
    (select count(*) from public.submissions s where s.assignment_id = a.id and s.is_late)::integer,
    (select count(*) from public.submissions s where s.assignment_id = a.id and s.status = 'accepted')::integer,
    (select count(*) from public.submissions s where s.assignment_id = a.id and s.status = 'resubmission_requested')::integer
  from public.assignments a
  where a.id = any (p_assignments) and public.is_staff_role(public.inst_role(a.institution_id)) and public.can_view_class(a.class_id);
$$;
revoke execute on function public.assignment_progress(uuid[]) from public, anon;
grant execute on function public.assignment_progress(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Scheduled retention job: pg_cron calls the homework-retention function
-- every hour with a secret kept in Vault (set up in HOMEWORK_RETENTION.md).
-- ---------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
