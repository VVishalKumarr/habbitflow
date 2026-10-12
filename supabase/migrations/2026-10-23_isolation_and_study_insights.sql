-- =====================================================================
-- Institution isolation follow-ups and study insights.
--
-- Part 1 — isolation fixes found in the October 2026 audit:
--   * Subject-level access: subject teachers see assessments, marks,
--     homework submissions and summaries only for the subjects they teach
--     (class teachers still see their whole class, coordinators their
--     grades, heads everything). can_view_subject() is the single rule.
--   * Class teachers of archived classes can no longer approve parent links.
--   * Refused role and membership changes are written to the database log
--     (deny()); role changes record a reason and notify the person.
--
-- Part 2 — study insights (weak-subject detection) and adaptive study plans:
--   * study_rules(): transparent, per-institution thresholds.
--   * compute_study_insights(): per-subject classification from published
--     marks, homework and teacher reviews, with the reasons. Missing data is
--     never counted as zero; too little data gives "insufficient_data".
--   * study_insights() / class_study_insights(): the only ways to read them,
--     scoped to the student, their linked parents, and staff by subject.
--   * study_insight_snapshots: history, to see whether things improve.
--   * subject_confidence: the student's own 1–5 rating per subject.
--   * study_plan_settings: the student's mode (off / recommend / auto) and
--     daily study limit. Plans are applied with apply_timetable_change()
--     (source 'ai_study_plan'), so they show in History and can be undone.
--     Only the student's personal timetable is ever changed.
-- Additive. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Refusals: write to the database log (kept even though the transaction
-- rolls back), then raise the usual NOT_ALLOWED error. No personal data
-- beyond the IDs is logged.
-- ---------------------------------------------------------------------
create or replace function public.deny(p_action text, p_inst uuid, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise log 'access_denied action=% user=% institution=%', p_action, coalesce(auth.uid()::text, '-'), coalesce(p_inst::text, '-');
  raise exception 'NOT_ALLOWED:%', p_message using errcode = '42501';
end;
$$;
revoke execute on function public.deny(text, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Subject-level access
-- ---------------------------------------------------------------------
-- Can the caller see academic records (assessments, marks, submissions) of
-- this subject in this class? Heads and view_all_classes: everything.
-- Coordinators: their grades. Class teachers: their whole class. Subject
-- teachers: only the subjects they teach there. Students: their own class
-- (row policies then limit them to their own records). Parents: never
-- directly (they use the guardian functions).
create or replace function public.can_view_subject(p_class uuid, p_subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c  public.classes;
  r  text;
  me uuid;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null then
    return false;
  end if;
  r := public.inst_role(c.institution_id);
  if r is null or r = 'parent' then
    return false;
  end if;
  if r in ('principal', 'director') or public.has_inst_perm(c.institution_id, 'view_all_classes') then
    return true;
  end if;
  me := public.my_membership_id(c.institution_id);
  if r = 'coordinator' and public.in_coordinator_scope(c.institution_id, c.grade) then
    return true;
  end if;
  if c.class_teacher_id = me then
    return true;
  end if;
  if exists (select 1 from public.teaching_assignments t where t.class_id = c.id and t.subject_id = p_subject and t.teacher_id = me) then
    return true;
  end if;
  if r = 'student' and exists (select 1 from public.class_enrollments e where e.class_id = c.id and e.student_id = me) then
    return true;
  end if;
  return false;
end;
$$;
revoke execute on function public.can_view_subject(uuid, uuid) from public, anon;
grant execute on function public.can_view_subject(uuid, uuid) to authenticated;

drop policy if exists "read" on public.assessments;
create policy "read" on public.assessments for select to authenticated
  using ((public.can_view_subject(class_id, subject_id) or teacher_id = public.my_membership_id(institution_id))
         and (status = 'published' or public.is_staff_role(public.inst_role(institution_id))));

drop policy if exists "read" on public.marks;
create policy "read" on public.marks for select to authenticated
  using (exists (
    select 1 from public.assessments a where a.id = assessment_id
      and ((public.is_staff_role(public.inst_role(a.institution_id))
            and (public.can_view_subject(a.class_id, a.subject_id) or a.teacher_id = public.my_membership_id(a.institution_id)))
           or (a.status = 'published' and student_id = public.my_membership_id(a.institution_id)))
  ));

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
           or (public.is_staff_role(public.inst_role(s.institution_id))
               and (public.can_view_subject(a.class_id, a.subject_id) or a.teacher_id = public.my_membership_id(a.institution_id))))
  );
$$;
revoke execute on function public.can_view_submission(uuid) from public, anon;
grant execute on function public.can_view_submission(uuid) to authenticated;

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
  where a.id = any (p_assignments) and public.is_staff_role(public.inst_role(a.institution_id))
    and (public.can_view_subject(a.class_id, a.subject_id) or a.teacher_id = public.my_membership_id(a.institution_id));
$$;
revoke execute on function public.assignment_progress(uuid[]) from public, anon;
grant execute on function public.assignment_progress(uuid[]) to authenticated;

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
      and (case when r = 'student' then e.student_id = me else public.can_view_subject(a.class_id, a.subject_id) end)
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
    and (case when r = 'student' then a.status = 'published' and k.student_id = me else public.can_view_subject(a.class_id, a.subject_id) end);

  return jsonb_build_object('since', since, 'attendance', att, 'homework', hw, 'marks', mk);
end;
$$;
revoke execute on function public.academic_summary(uuid, uuid, integer) from public, anon;
grant execute on function public.academic_summary(uuid, uuid, integer) to authenticated;

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
    perform public.deny('export_marks', p_inst, 'You can’t export this.');
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
     and (p_class is null or a.class_id = p_class) and public.can_view_subject(a.class_id, a.subject_id)
   order by a.assessment_date, c.name, sj.name, a.title, m.display_name;
end;
$$;
revoke execute on function public.export_marks(uuid, uuid, date, date) from public, anon;
grant execute on function public.export_marks(uuid, uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- Parent links: only the class teacher of a current (non-archived) class.
-- ---------------------------------------------------------------------
create or replace function public.can_approve_guardian_for(p_user uuid, p_link uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guardian_links g
    where g.id = p_link
      and (public.has_inst_perm_for(p_user, g.institution_id, 'manage_students')
           or exists (select 1 from public.class_enrollments e
                      join public.classes c on c.id = e.class_id and not c.archived
                      join public.institution_memberships m on m.id = c.class_teacher_id
                      where e.student_id = g.student_id and m.user_id = p_user and m.status = 'active'
                        and public.inst_role_for(p_user, g.institution_id) is not null))
  );
$$;
revoke execute on function public.can_approve_guardian_for(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Membership changes: refusals are logged; role changes carry a reason
-- (stored in the audit history) and notify the person.
-- ---------------------------------------------------------------------
create or replace function public.set_member_status(p_membership uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.institution_memberships;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into m from public.institution_memberships where id = p_membership for update;
  if m.id is null or not public.can_administer_member(m.institution_id, m.role) then
    perform public.deny('set_member_status', m.institution_id, 'Member not found.');
  end if;
  if m.user_id = auth.uid() then
    perform public.deny('set_member_status_self', m.institution_id, 'You can’t change your own access.');
  end if;
  if p_status not in ('active', 'suspended', 'revoked') then
    raise exception 'Invalid status.';
  end if;
  if p_status <> 'active' and char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason (at least 3 characters).';
  end if;
  if m.status = p_status then
    return;
  end if;
  perform set_config('habitflow.audit_reason', coalesce(p_reason, ''), true);
  update public.institution_memberships
     set status = p_status, status_reason = nullif(btrim(coalesce(p_reason, '')), ''), status_changed_at = now()
   where id = m.id;
  if p_status <> 'active' and m.user_id is not null then
    delete from auth.sessions where user_id = m.user_id;
  end if;
end;
$$;
revoke execute on function public.set_member_status(uuid, text, text) from public, anon;
grant execute on function public.set_member_status(uuid, text, text) to authenticated;

-- Edit name / ID / role. Staff roles change only among coordinator, class
-- teacher and subject teacher, and only with manage_staff (heads). So only
-- a principal or director can make or remove a coordinator.
drop function if exists public.update_member(uuid, text, text, text);
create or replace function public.update_member(p_membership uuid, p_name text, p_external_id text, p_role text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.institution_memberships;
  new_role text := coalesce(p_role, '');
  label jsonb := jsonb_build_object('coordinator', 'Coordinator', 'class_teacher', 'Class teacher', 'subject_teacher', 'Subject teacher');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into m from public.institution_memberships where id = p_membership for update;
  if m.id is null or not public.can_administer_member(m.institution_id, m.role) then
    perform public.deny('update_member', m.institution_id, 'Member not found.');
  end if;
  if new_role = '' then
    new_role := m.role;
  end if;
  if new_role <> m.role then
    if m.user_id = auth.uid() then
      perform public.deny('change_own_role', m.institution_id, 'You can’t change your own role.');
    end if;
    if new_role not in ('coordinator', 'class_teacher', 'subject_teacher') or m.role not in ('coordinator', 'class_teacher', 'subject_teacher') then
      raise exception 'Roles can only change between coordinator, class teacher and subject teacher.';
    end if;
    if not public.has_inst_perm(m.institution_id, 'manage_staff') then
      perform public.deny('change_role', m.institution_id, 'Only the principal or director can change staff roles.');
    end if;
    if m.role = 'coordinator' then
      delete from public.coordinator_scopes where coordinator_id = m.id;
    end if;
    perform set_config('habitflow.audit_reason', left(btrim(coalesce(p_reason, '')), 500), true);
  end if;
  update public.institution_memberships
     set display_name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), display_name),
         external_id = nullif(btrim(coalesce(p_external_id, '')), ''),
         role = new_role
   where id = m.id;
  if new_role <> m.role and m.user_id is not null then
    perform public.notify(m.user_id, m.institution_id, 'role_changed', 'Your role changed',
      'Your role is now ' || coalesce(label ->> new_role, new_role) || '.', '/school', null);
  end if;
end;
$$;
revoke execute on function public.update_member(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_member(uuid, text, text, text, text) to authenticated;

-- =====================================================================
-- Part 2: study insights
-- =====================================================================

-- Per-institution thresholds (heads change them; defaults below).
create table if not exists public.study_insight_rules (
  id             uuid not null default gen_random_uuid() unique,
  institution_id uuid primary key references public.institutions (id) on delete cascade,
  rules          jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  updated_at     timestamptz not null default now()
);
alter table public.study_insight_rules enable row level security;
revoke all on public.study_insight_rules from anon, authenticated;
drop policy if exists "staff read" on public.study_insight_rules;
create policy "staff read" on public.study_insight_rules for select to authenticated
  using (public.is_staff_role(public.inst_role(institution_id)));
grant select on public.study_insight_rules to authenticated;
drop trigger if exists study_insight_rules_audit on public.study_insight_rules;
create trigger study_insight_rules_audit after insert or update or delete on public.study_insight_rules
  for each row execute function public.audit_row_change();

-- Internal: the rules with defaults filled in (no permission check).
create or replace function public.study_rules_for(p_inst uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select d || r || jsonb_build_object(
           'extra_minutes', (d -> 'extra_minutes') || coalesce(r -> 'extra_minutes', '{}'::jsonb),
           'kind_weights', (d -> 'kind_weights') || coalesce(r -> 'kind_weights', '{}'::jsonb))
    from (select jsonb_build_object(
      'window_days', 180,              -- marks and homework considered
      'min_assessments', 2,            -- published marks needed to judge from marks
      'min_homework', 3,               -- homework due needed to judge from homework
      'attention_below', 50,           -- indicator below this: needs attention
      'strong_from', 80,               -- indicator from this: strong
      'decline_points', 10,            -- drop vs earlier results that counts as a decline
      'homework_attention_below', 60,  -- homework handed in (%) below this: needs attention
      'marks_weight', 80,              -- share of marks in the indicator when homework also counts
      'refresh_days', 7,               -- re-analyse at least this often
      'kind_weights', jsonb_build_object('internal', 1, 'external', 1.5, 'project', 1, 'practical', 1),
      'extra_minutes', jsonb_build_object('needs_attention', 120, 'improving', 60, 'on_track', 0, 'strong', -30),
      'exam_bonus_minutes', 60,        -- extra weekly time when an exam is within 3 weeks
      'max_daily_study_minutes', 180   -- default limit for students who haven't set one
    ) d, coalesce((select rules from public.study_insight_rules where institution_id = p_inst), '{}'::jsonb) r) x;
$$;
revoke execute on function public.study_rules_for(uuid) from public, anon, authenticated;

-- Staff of the institution read the rules (students and parents get them with their insights).
create or replace function public.study_rules(p_inst uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_staff_role(public.inst_role(p_inst)) then public.study_rules_for(p_inst) end;
$$;
revoke execute on function public.study_rules(uuid) from public, anon;
grant execute on function public.study_rules(uuid) to authenticated;

create or replace function public.set_study_rules(p_inst uuid, p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  nums jsonb := jsonb_build_object(
    'window_days', jsonb_build_array(30, 730), 'min_assessments', jsonb_build_array(1, 10), 'min_homework', jsonb_build_array(1, 20),
    'attention_below', jsonb_build_array(10, 90), 'strong_from', jsonb_build_array(50, 100), 'decline_points', jsonb_build_array(1, 50),
    'homework_attention_below', jsonb_build_array(0, 100), 'marks_weight', jsonb_build_array(0, 100), 'refresh_days', jsonb_build_array(1, 60),
    'exam_bonus_minutes', jsonb_build_array(0, 300), 'max_daily_study_minutes', jsonb_build_array(30, 600));
begin
  if not public.has_inst_perm(p_inst, 'manage_institution_settings') then
    perform public.deny('set_study_rules', p_inst, 'Only the principal or director can change these rules.');
  end if;
  if jsonb_typeof(p_rules) <> 'object' then
    raise exception 'INVALID:Rules must be an object.';
  end if;
  for k, v in select * from jsonb_each(p_rules) loop
    if nums ? k then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between (nums -> k ->> 0)::numeric and (nums -> k ->> 1)::numeric then
        raise exception 'INVALID:% must be a number from % to %.', k, nums -> k ->> 0, nums -> k ->> 1;
      end if;
    elsif k = 'extra_minutes' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) e
           where e.key not in ('needs_attention', 'improving', 'on_track', 'strong')
              or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between -300 and 600) then
        raise exception 'INVALID:extra_minutes: minutes from -300 to 600 for needs_attention, improving, on_track and strong.';
      end if;
    elsif k = 'kind_weights' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) e
           where e.key not in ('internal', 'external', 'project', 'practical')
              or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0.1 and 5) then
        raise exception 'INVALID:kind_weights: weights from 0.1 to 5 for internal, external, project and practical.';
      end if;
    else
      raise exception 'INVALID:Unknown rule: %', k;
    end if;
  end loop;
  if coalesce((p_rules ->> 'attention_below')::numeric, 50) >= coalesce((p_rules ->> 'strong_from')::numeric, 80) then
    raise exception 'INVALID:“Needs attention below” must be lower than “Strong from”.';
  end if;
  insert into public.study_insight_rules (institution_id, rules) values (p_inst, p_rules)
  on conflict (institution_id) do update set rules = excluded.rules, updated_at = now();
  return public.study_rules_for(p_inst);
end;
$$;
revoke execute on function public.set_study_rules(uuid, jsonb) from public, anon;
grant execute on function public.set_study_rules(uuid, jsonb) to authenticated;

-- The student's own confidence per subject (optional, 1–5).
create table if not exists public.subject_confidence (
  institution_id uuid not null references public.institutions (id) on delete cascade,
  student_id     uuid not null,
  subject_id     uuid not null,
  confidence     smallint not null check (confidence between 1 and 5),
  updated_at     timestamptz not null default now(),
  primary key (student_id, subject_id),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade,
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id) on delete cascade
);
alter table public.subject_confidence enable row level security;
revoke all on public.subject_confidence from anon, authenticated;
drop policy if exists "own" on public.subject_confidence;
create policy "own" on public.subject_confidence for select to authenticated
  using (student_id = public.my_membership_id(institution_id));
grant select on public.subject_confidence to authenticated;

create or replace function public.set_subject_confidence(p_inst uuid, p_subject uuid, p_confidence integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.my_membership_id(p_inst);
begin
  if me is null or public.inst_role(p_inst) <> 'student' then
    perform public.deny('set_subject_confidence', p_inst, 'Only students can rate their confidence.');
  end if;
  if not exists (select 1 from public.class_enrollments e join public.classes c on c.id = e.class_id and not c.archived
                  join public.teaching_assignments t on t.class_id = c.id and t.subject_id = p_subject
                 where e.student_id = me) then
    perform public.deny('set_subject_confidence', p_inst, 'That subject isn’t in your classes.');
  end if;
  if p_confidence is null then
    delete from public.subject_confidence where student_id = me and subject_id = p_subject;
    return;
  end if;
  if p_confidence not between 1 and 5 then
    raise exception 'INVALID:Confidence is from 1 to 5.';
  end if;
  insert into public.subject_confidence (institution_id, student_id, subject_id, confidence)
  values (p_inst, me, p_subject, p_confidence)
  on conflict (student_id, subject_id) do update set confidence = excluded.confidence, updated_at = now();
end;
$$;
revoke execute on function public.set_subject_confidence(uuid, uuid, integer) from public, anon;
grant execute on function public.set_subject_confidence(uuid, uuid, integer) to authenticated;

-- History of analyses (read only through study_insights()).
create table if not exists public.study_insight_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  institution_id      uuid not null references public.institutions (id) on delete cascade,
  student_id          uuid not null,
  subject_id          uuid not null,
  status              text not null check (status in ('needs_attention', 'improving', 'on_track', 'strong', 'insufficient_data')),
  indicator           numeric(5, 1) check (indicator is null or indicator between 0 and 100),
  recommended_minutes integer not null default 0 check (recommended_minutes between -600 and 900),
  reasons             jsonb not null default '[]'::jsonb,
  signature           text not null,
  computed_at         timestamptz not null default now(),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade,
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id) on delete cascade
);
create index if not exists study_snapshots_idx on public.study_insight_snapshots (student_id, subject_id, computed_at desc);
alter table public.study_insight_snapshots enable row level security;
revoke all on public.study_insight_snapshots from anon, authenticated;

-- The student's plan settings (personal, like the timetable itself).
create table if not exists public.study_plan_settings (
  user_id                 uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  mode                    text not null default 'recommend' check (mode in ('off', 'recommend', 'auto')),
  max_daily_study_minutes integer check (max_daily_study_minutes is null or max_daily_study_minutes between 30 and 600),
  tracker_id              uuid references public.trackers (id) on delete set null,
  last_applied_signature  text check (last_applied_signature is null or char_length(last_applied_signature) <= 64),
  last_applied_at         timestamptz,
  updated_at              timestamptz not null default now()
);
alter table public.study_plan_settings enable row level security;
revoke all on public.study_plan_settings from anon;
drop policy if exists "own rows" on public.study_plan_settings;
create policy "own rows" on public.study_plan_settings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (tracker_id is null or exists (select 1 from public.trackers t where t.id = tracker_id and t.user_id = (select auth.uid()))));
grant select, insert, update, delete on public.study_plan_settings to authenticated;
drop trigger if exists study_plan_settings_updated_at on public.study_plan_settings;
create trigger study_plan_settings_updated_at before update on public.study_plan_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- The analysis. Internal: no permission checks (callers check).
-- Returns an array, one object per subject of the student's current
-- classes (a subject with a teacher or published marks there).
-- ---------------------------------------------------------------------
create or replace function public.compute_study_insights(p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m        public.institution_memberships;
  rules    jsonb;
  since    date;
  today    date;
  sj       record;
  out      jsonb := '[]'::jsonb;
  scores   jsonb;
  n        integer;
  absent   integer;
  recent   numeric;
  overall  numeric;
  earlier  numeric;
  change   numeric;
  last3    numeric[];
  falling  boolean;
  hw_exp   integer;
  hw_miss  integer;
  hw_late  integer;
  hw_flag  integer;
  hw_rate  numeric;
  conf     smallint;
  exam     jsonb;
  revisit  jsonb;
  has_marks boolean;
  has_hw   boolean;
  ind      numeric;
  st       text;
  rec_min  integer;
  reasons  jsonb;
  mw       numeric;
begin
  select * into m from public.institution_memberships where id = p_student and role = 'student';
  if m.id is null then
    return '[]'::jsonb;
  end if;
  rules := public.study_rules_for(m.institution_id);
  today := (now() at time zone (select timezone from public.institutions where id = m.institution_id))::date;
  since := today - (rules ->> 'window_days')::int;
  mw := (rules ->> 'marks_weight')::numeric;

  for sj in
    select s.id, s.name, array_agg(distinct c.id) class_ids
      from public.class_enrollments e
      join public.classes c on c.id = e.class_id and not c.archived
      join public.subjects s on s.institution_id = c.institution_id and not s.archived
     where e.student_id = p_student
       and (exists (select 1 from public.teaching_assignments t where t.class_id = c.id and t.subject_id = s.id)
            or exists (select 1 from public.assessments a where a.class_id = c.id and a.subject_id = s.id and a.status = 'published'))
     group by s.id, s.name
     order by s.name
  loop
    -- Published marks (percentages, so different maximums compare).
    select coalesce(jsonb_agg(jsonb_build_object('date', x.assessment_date, 'title', x.title, 'kind', x.kind, 'pct', x.pct)
                              order by x.assessment_date, x.title), '[]'::jsonb),
           count(*)
      into scores, n
      from (select a.assessment_date, a.title, a.kind, round(k.obtained / a.max_marks * 100, 1) pct
              from public.marks k join public.assessments a on a.id = k.assessment_id
             where k.student_id = p_student and a.subject_id = sj.id and a.status = 'published'
               and not k.absent and k.obtained is not null and a.assessment_date >= since) x;
    select count(*) into absent
      from public.marks k join public.assessments a on a.id = k.assessment_id
     where k.student_id = p_student and a.subject_id = sj.id and a.status = 'published' and k.absent and a.assessment_date >= since;

    recent := null; overall := null; earlier := null; change := null; falling := false;
    if n > 0 then
      -- weighted by assessment kind; "recent" = the last three
      select round(sum(pct * w) / sum(w), 1) into overall
        from (select (e ->> 'pct')::numeric pct, coalesce((rules -> 'kind_weights' ->> (e ->> 'kind'))::numeric, 1) w
                from jsonb_array_elements(scores) e) z;
      select round(sum(pct * w) / sum(w), 1) into recent
        from (select (e ->> 'pct')::numeric pct, coalesce((rules -> 'kind_weights' ->> (e ->> 'kind'))::numeric, 1) w
                from jsonb_array_elements(scores) with ordinality t(e, i) where i > n - 3) z;
      if n >= 2 then
        select round(avg((e ->> 'pct')::numeric), 1) into earlier
          from jsonb_array_elements(scores) with ordinality t(e, i) where i between greatest(1, n - 3) and n - 1;
        change := round((scores -> (n - 1) ->> 'pct')::numeric - earlier, 1);
      end if;
      if n >= 3 then
        select array_agg((e ->> 'pct')::numeric order by i) into last3
          from jsonb_array_elements(scores) with ordinality t(e, i) where i > n - 3;
        falling := last3[1] > last3[2] and last3[2] > last3[3] and last3[1] - last3[3] >= (rules ->> 'decline_points')::numeric;
      end if;
    end if;

    -- Homework due in the window.
    select count(*),
           count(*) filter (where s.status is null or s.status = 'not_submitted'),
           count(*) filter (where s.is_late),
           count(*) filter (where s.status in ('resubmission_requested', 'rejected'))
      into hw_exp, hw_miss, hw_late, hw_flag
      from public.assignments a
      join public.class_enrollments e on e.class_id = a.class_id and e.student_id = p_student
      left join public.submissions s on s.assignment_id = a.id and s.student_id = p_student
     where a.subject_id = sj.id and a.status in ('published', 'closed') and a.due_at < now() and a.due_at::date >= since;
    hw_rate := case when hw_exp > 0 then round((hw_exp - hw_miss)::numeric / hw_exp * 100, 1) end;

    select confidence into conf from public.subject_confidence where student_id = p_student and subject_id = sj.id;

    select jsonb_build_object('title', ev.title, 'starts_on', ev.starts_on) into exam
      from public.calendar_events ev
     where ev.institution_id = m.institution_id and ev.kind = 'exam' and ev.status = 'scheduled'
       and (ev.subject_id = sj.id)
       and exists (select 1 from public.classes c where c.id = any (sj.class_ids)
                    and public.event_applies(ev.class_id, ev.grade, c.id, c.grade))
       and ev.starts_on between today and today + 21
     order by ev.starts_on limit 1;

    select coalesce(jsonb_agg(e ->> 'title' order by (e ->> 'date') desc), '[]'::jsonb) into revisit
      from (select e from jsonb_array_elements(scores) e
             where (e ->> 'pct')::numeric < (rules ->> 'attention_below')::numeric
             order by e ->> 'date' desc limit 3) z;

    has_marks := n >= (rules ->> 'min_assessments')::int;
    has_hw := hw_exp >= (rules ->> 'min_homework')::int;
    reasons := '[]'::jsonb;

    if not has_marks and not has_hw then
      st := 'insufficient_data';
      ind := null;
      reasons := reasons || jsonb_build_object('kind', 'info', 'text',
        format('Only %s published mark%s and %s homework piece%s so far — not enough to judge this subject yet.',
               n, case when n = 1 then '' else 's' end, hw_exp, case when hw_exp = 1 then '' else 's' end));
    else
      ind := case when has_marks and has_hw then round((mw * recent + (100 - mw) * hw_rate) / 100, 1)
                  when has_marks then recent
                  else hw_rate end;
      if (ind < (rules ->> 'attention_below')::numeric)
         or (has_hw and hw_rate < (rules ->> 'homework_attention_below')::numeric)
         or (has_marks and (falling or change <= -(rules ->> 'decline_points')::numeric) and recent < (rules ->> 'strong_from')::numeric) then
        st := 'needs_attention';
      elsif has_marks and change >= (rules ->> 'decline_points')::numeric / 2 and ind < (rules ->> 'strong_from')::numeric then
        st := 'improving';
      elsif has_marks and ind >= (rules ->> 'strong_from')::numeric and not falling
            and coalesce(change, 0) > -(rules ->> 'decline_points')::numeric
            and (not has_hw or hw_rate >= (rules ->> 'homework_attention_below')::numeric) then
        st := 'strong';
      else
        st := 'on_track';
      end if;

      if has_marks then
        reasons := reasons || jsonb_build_object('kind',
          case when recent < (rules ->> 'attention_below')::numeric then 'concern'
               when recent >= (rules ->> 'strong_from')::numeric then 'strength' else 'info' end,
          'text', format('Recent results average %s%% (last %s of %s published mark%s).', recent, least(n, 3), n, case when n = 1 then '' else 's' end));
      else
        reasons := reasons || jsonb_build_object('kind', 'info', 'text',
          format('Only %s published mark%s, so this is judged from homework.', n, case when n = 1 then '' else 's' end));
      end if;
      if falling then
        reasons := reasons || jsonb_build_object('kind', 'concern', 'text',
          format('Results fell over the last three assessments: %s%% → %s%% → %s%%.', last3[1], last3[2], last3[3]));
      elsif change is not null and change <= -(rules ->> 'decline_points')::numeric then
        reasons := reasons || jsonb_build_object('kind', 'concern', 'text',
          format('The latest result is %s points below the ones before it.', abs(change)));
      elsif change is not null and change >= (rules ->> 'decline_points')::numeric / 2 then
        reasons := reasons || jsonb_build_object('kind', 'strength', 'text',
          format('The latest result is %s points above the ones before it.', change));
      end if;
      if has_hw then
        reasons := reasons || jsonb_build_object('kind',
          case when hw_rate < (rules ->> 'homework_attention_below')::numeric then 'concern'
               when hw_miss = 0 and hw_late = 0 then 'strength' else 'info' end,
          'text', case when hw_miss = 0 and hw_late = 0 then format('All %s homework pieces handed in on time.', hw_exp)
                       else format('%s of %s homework pieces handed in%s.', hw_exp - hw_miss, hw_exp,
                                   case when hw_late > 0 then format(', %s late', hw_late) else '' end) end);
      end if;
    end if;
    if hw_flag > 0 then
      reasons := reasons || jsonb_build_object('kind', 'concern', 'text',
        format('Teachers asked for changes or turned down %s piece%s of homework.', hw_flag, case when hw_flag = 1 then '' else 's' end));
    end if;
    if absent > 0 then
      reasons := reasons || jsonb_build_object('kind', 'info', 'text',
        format('Absent for %s assessment%s — not counted as zero.', absent, case when absent = 1 then '' else 's' end));
    end if;
    if conf is not null and conf <= 2 then
      reasons := reasons || jsonb_build_object('kind', 'info', 'text', format('You rated your confidence %s out of 5.', conf));
    end if;
    if exam is not null then
      reasons := reasons || jsonb_build_object('kind', 'info', 'text',
        format('Exam “%s” on %s.', exam ->> 'title', to_char((exam ->> 'starts_on')::date, 'DD Mon')));
    end if;

    rec_min := case when st = 'insufficient_data' then 0 else coalesce((rules -> 'extra_minutes' ->> st)::int, 0) end
             + case when exam is not null then (rules ->> 'exam_bonus_minutes')::int else 0 end
             + case when conf is not null and conf <= 2 and st not in ('strong', 'insufficient_data') then 30 else 0 end;

    out := out || jsonb_build_object(
      'subject_id', sj.id, 'subject', sj.name, 'class_ids', to_jsonb(sj.class_ids),
      'status', st, 'indicator', ind, 'recommended_minutes', rec_min, 'reasons', reasons,
      'evidence', jsonb_build_object(
        'assessments', (select coalesce(jsonb_agg(e order by i), '[]'::jsonb) from jsonb_array_elements(scores) with ordinality t(e, i) where i > n - 8),
        'marks_count', n, 'recent_avg', recent, 'overall_avg', overall, 'change', change, 'absent', absent,
        'homework', jsonb_build_object('expected', hw_exp, 'missing', hw_miss, 'late', hw_late, 'needs_changes', hw_flag, 'completion', hw_rate),
        'confidence', conf, 'exam', exam, 'revisit', revisit, 'topics_available', false),
      -- any change in results, homework, self-rating, exams or rules means a new analysis
      'signature', md5(concat_ws('|', scores::text, absent, hw_exp, hw_miss, hw_late, hw_flag, conf, exam::text, rules::text)));
  end loop;
  return out;
end;
$$;
revoke execute on function public.compute_study_insights(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Reading insights. The student: everything. Linked parents: a summary.
-- Staff: only subjects they may see (can_view_subject), only for students
-- in classes they can see. Anyone else is refused (and it is logged).
-- New snapshots are stored when the data changed or refresh_days passed.
-- ---------------------------------------------------------------------
create or replace function public.study_insights(p_student uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m       public.institution_memberships;
  r       text;
  viewer  text;
  rules   jsonb;
  all_s   jsonb;
  s       jsonb;
  visible jsonb := '[]'::jsonb;
  prev    public.study_insight_snapshots;
  hist    jsonb;
  analysed timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select * into m from public.institution_memberships where id = p_student and role = 'student';
  r := case when m.id is not null then public.inst_role(m.institution_id) end;
  if m.id is not null and m.user_id = auth.uid() and r = 'student' then
    viewer := 'student';
  elsif r is not null and public.is_staff_role(r)
        and exists (select 1 from public.class_enrollments e where e.student_id = m.id and public.can_view_class(e.class_id)) then
    viewer := 'staff';
  elsif m.id is not null and public.is_guardian_of(m.id) then
    viewer := 'parent';
  else
    perform public.deny('study_insights', m.institution_id, 'Student not found.');
  end if;

  rules := public.study_rules_for(m.institution_id);
  all_s := public.compute_study_insights(m.id);
  for s in select * from jsonb_array_elements(all_s) loop
    if viewer = 'staff' and not exists (select 1 from jsonb_array_elements_text(s -> 'class_ids') c
                                         where public.can_view_subject(c::uuid, (s ->> 'subject_id')::uuid)) then
      continue;
    end if;
    -- snapshot when something changed or it is due
    select * into prev from public.study_insight_snapshots
     where student_id = m.id and subject_id = (s ->> 'subject_id')::uuid order by computed_at desc limit 1;
    if prev.id is null or prev.signature <> s ->> 'signature'
       or prev.computed_at < now() - make_interval(days => (rules ->> 'refresh_days')::int) then
      insert into public.study_insight_snapshots (institution_id, student_id, subject_id, status, indicator, recommended_minutes, reasons, signature)
      values (m.institution_id, m.id, (s ->> 'subject_id')::uuid, s ->> 'status', (s ->> 'indicator')::numeric,
              (s ->> 'recommended_minutes')::int, s -> 'reasons', s ->> 'signature')
      returning computed_at into analysed;
    else
      analysed := prev.computed_at;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('status', h.status, 'indicator', h.indicator, 'at', h.computed_at) order by h.computed_at), '[]'::jsonb)
      into hist
      from (select * from public.study_insight_snapshots
             where student_id = m.id and subject_id = (s ->> 'subject_id')::uuid order by computed_at desc limit 8) h;
    s := s - 'signature' - 'class_ids' || jsonb_build_object('analysed_at', analysed, 'history', hist);
    if viewer = 'parent' then
      s := s - 'evidence' || jsonb_build_object('evidence', jsonb_build_object('exam', s -> 'evidence' -> 'exam'));
      s := s || jsonb_build_object('reasons', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(s -> 'reasons') x
                                                where x ->> 'text' not like 'You rated%'));
    elsif viewer = 'staff' then
      s := s || jsonb_build_object('reasons', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(s -> 'reasons') x
                                                where x ->> 'text' not like 'You rated%'))
             || jsonb_build_object('evidence', (s -> 'evidence') - 'confidence');
    end if;
    visible := visible || s;
  end loop;

  return jsonb_build_object(
    'student_id', m.id, 'student', m.display_name, 'institution_id', m.institution_id, 'viewer', viewer,
    'analysed_at', now(),
    'rules', rules - 'kind_weights',
    'subjects', visible);
end;
$$;
revoke execute on function public.study_insights(uuid) from public, anon;
grant execute on function public.study_insights(uuid) to authenticated;

-- Teachers: one class at a glance, limited to the subjects they may see.
create or replace function public.class_study_insights(p_class uuid)
returns table (student_id uuid, student text, roll_no text, subject_id uuid, subject text, status text, indicator numeric,
               recommended_minutes integer, top_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.classes;
  e record;
  s jsonb;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or not public.is_staff_role(public.inst_role(c.institution_id)) or not public.can_view_class(p_class) then
    perform public.deny('class_study_insights', c.institution_id, 'You can’t see this class.');
  end if;
  for e in select en.student_id, m.display_name, en.roll_no
             from public.class_enrollments en join public.institution_memberships m on m.id = en.student_id and m.status = 'active'
            where en.class_id = p_class order by en.roll_no nulls last, m.display_name loop
    for s in select * from jsonb_array_elements(public.compute_study_insights(e.student_id)) loop
      if not public.can_view_subject(p_class, (s ->> 'subject_id')::uuid) then
        continue;
      end if;
      student_id := e.student_id; student := e.display_name; roll_no := e.roll_no;
      subject_id := (s ->> 'subject_id')::uuid; subject := s ->> 'subject'; status := s ->> 'status';
      indicator := (s ->> 'indicator')::numeric; recommended_minutes := (s ->> 'recommended_minutes')::int;
      top_reason := (select x ->> 'text' from jsonb_array_elements(s -> 'reasons') x
                      where x ->> 'text' not like 'You rated%'
                      order by case x ->> 'kind' when 'concern' then 0 when 'info' then 1 else 2 end limit 1);
      return next;
    end loop;
  end loop;
end;
$$;
revoke execute on function public.class_study_insights(uuid) from public, anon;
grant execute on function public.class_study_insights(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Study plans go through the existing, undoable timetable change path.
-- ---------------------------------------------------------------------
alter table public.timetable_changes drop constraint if exists timetable_changes_source_check;
alter table public.timetable_changes add constraint timetable_changes_source_check
  check (source in ('ai_generate', 'ai_reschedule', 'voice', 'undo', 'teacher', 'ai_study_plan'));

create or replace function public.apply_timetable_change(
  p_tracker uuid, p_new_name text, p_base_version text, p_source text, p_summary text, p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid      uuid := auth.uid();
  v_tracker uuid := p_tracker;
  v_before text;
  v_inverse jsonb;
  v_after  text;
  v_change uuid;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_source not in ('ai_generate', 'ai_reschedule', 'voice', 'ai_study_plan') then
    raise exception 'INVALID_CHANGE:unknown source' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_summary, ''))) not between 1 and 300 then
    raise exception 'INVALID_CHANGE:summary' using errcode = 'P0001';
  end if;
  if p_source = 'ai_study_plan' and (p_tracker is null or exists (
       select 1 from jsonb_array_elements(p_ops) o
        where o ->> 'op' not in ('add_task', 'update_task')
           or (o ->> 'op' = 'add_task' and coalesce(o ->> 'category', '') <> 'study')
           or (o ->> 'op' = 'update_task' and (coalesce(o ->> 'category', '') <> 'study'
               or not exists (select 1 from public.tasks k where k.id = (o ->> 'task')::uuid and k.user_id = uid and k.category = 'study'))))) then
    -- a study plan only adds study sessions or re-labels existing study sessions
    raise exception 'INVALID_CHANGE:a study plan can only add or re-label study sessions' using errcode = 'P0001';
  end if;

  if v_tracker is null then
    insert into public.trackers (user_id, name) values (uid, btrim(coalesce(p_new_name, '')))
    returning id into v_tracker;
  else
    -- Row lock: two saves of the same timetable can't interleave.
    perform 1 from public.trackers t where t.id = v_tracker and t.user_id = uid for update;
    if not found then
      raise exception 'INVALID_CHANGE:unknown timetable' using errcode = 'P0001';
    end if;
    v_before := public.timetable_version(v_tracker);
    if p_base_version is null or p_base_version <> v_before then
      raise exception 'STALE_TIMETABLE' using errcode = 'P0001';
    end if;
  end if;

  v_inverse := public.tt_apply_ops(v_tracker, uid, p_ops);
  v_after := public.timetable_version(v_tracker);

  insert into public.timetable_changes (user_id, tracker_id, source, summary, ops, inverse, before_version, after_version)
  values (uid, v_tracker, p_source, btrim(p_summary), p_ops, case when p_tracker is null then null else v_inverse end, v_before, v_after)
  returning id into v_change;

  return jsonb_build_object('tracker_id', v_tracker, 'change_id', v_change, 'version', v_after);
end;
$$;
revoke execute on function public.apply_timetable_change(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.apply_timetable_change(uuid, text, text, text, text, jsonb) to authenticated;
