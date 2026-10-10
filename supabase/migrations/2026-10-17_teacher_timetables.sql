-- =====================================================================
-- Class teachers edit timetables.
--
-- * New permission manage_timetable: edit a class's weekly periods without
--   needing manage_classes (classes, subjects, enrolment). Default: class
--   teachers (their own class) and coordinators (their grades).
-- * New permission edit_student_timetables: a class teacher may read and edit
--   the personal timetables of students enrolled in their class. Default on
--   for class teachers; the principal/director can switch it off.
--   Every edit goes through tt_apply_ops (one transaction, stale edits
--   refused), is recorded in the student's timetable history with the
--   teacher's name, written to the audit log, and the student is notified
--   and can undo it. Teachers never see ticks or progress.
-- Additive. Safe to re-run.
-- =====================================================================

create or replace function public.all_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'manage_institution_settings', 'manage_license', 'manage_staff', 'manage_students', 'manage_classes',
    'manage_calendar', 'approve_deadline_changes', 'view_all_classes', 'view_audit', 'set_homework_retention',
    'manage_programmes', 'import_export', 'view_reports', 'record_attendance', 'create_assignments',
    'enter_marks', 'message_parents', 'manage_timetable', 'edit_student_timetables'
  ];
$$;

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
                                    'manage_timetable', 'edit_student_timetables']
    when 'subject_teacher' then array['record_attendance', 'create_assignments', 'enter_marks']
    else array[]::text[]
  end;
$$;

-- ---------------------------------------------------------------------
-- Class timetable (class_periods)
-- ---------------------------------------------------------------------
create or replace function public.can_edit_class_timetable(p_class uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.classes;
  r text;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null then
    return false;
  end if;
  if public.can_manage_class(p_class) then
    return true;
  end if;
  if not public.has_inst_perm(c.institution_id, 'manage_timetable') then
    return false;
  end if;
  r := public.inst_role(c.institution_id);
  if r in ('principal', 'director') then
    return true;
  end if;
  if r = 'coordinator' then
    return public.in_coordinator_scope(c.institution_id, c.grade);
  end if;
  return r = 'class_teacher' and c.class_teacher_id = public.my_membership_id(c.institution_id);
end;
$$;
revoke execute on function public.can_edit_class_timetable(uuid) from public, anon;
grant execute on function public.can_edit_class_timetable(uuid) to authenticated;

drop policy if exists "manage" on public.class_periods;
create policy "manage" on public.class_periods for all to authenticated
  using (public.can_edit_class_timetable(class_id)) with check (public.can_edit_class_timetable(class_id));

-- ---------------------------------------------------------------------
-- History: who made a change
-- ---------------------------------------------------------------------
alter table public.timetable_changes add column if not exists actor_id uuid references auth.users (id) on delete set null;
alter table public.timetable_changes add column if not exists actor_name text check (actor_name is null or char_length(actor_name) <= 80);
alter table public.timetable_changes drop constraint if exists timetable_changes_source_check;
alter table public.timetable_changes add constraint timetable_changes_source_check
  check (source in ('ai_generate', 'ai_reschedule', 'voice', 'undo', 'teacher'));
grant select (actor_name) on public.timetable_changes to authenticated;

-- Steps now include update_task (rename / recategorise / note).
create or replace function public.tt_apply_ops(p_tracker uuid, p_user uuid, p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  op       jsonb;
  refs     jsonb := '{}'::jsonb;
  inverse  jsonb := '[]'::jsonb;
  v_slot   uuid;
  v_task   uuid;
  v_day    smallint;
  v_row    public.tasks;
  v_srow   public.time_slots;
  v_kind   text;
begin
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 then
    raise exception 'INVALID_CHANGE:no steps' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_ops) > 400 then
    raise exception 'INVALID_CHANGE:too many steps' using errcode = 'P0001';
  end if;

  for op in select value from jsonb_array_elements(p_ops) loop
    v_kind := op ->> 'op';

    -- Resolve the target slot (an existing slot of this timetable, or one added earlier in this change).
    v_slot := null;
    if v_kind in ('add_task', 'move_task', 'delete_slot') then
      if op ? 'slot_ref' then
        v_slot := (refs ->> (op ->> 'slot_ref'))::uuid;
      elsif op ? 'slot' then
        select s.id into v_slot from public.time_slots s
         where s.id = (op ->> 'slot')::uuid and s.tracker_id = p_tracker and s.user_id = p_user;
      end if;
      if v_slot is null then
        raise exception 'INVALID_CHANGE:unknown time slot' using errcode = 'P0001';
      end if;
    end if;
    if v_kind in ('add_task', 'move_task') then
      v_day := (op ->> 'day')::smallint;
      if v_day is null or v_day not between 0 and 6 then
        raise exception 'INVALID_CHANGE:invalid day' using errcode = 'P0001';
      end if;
    end if;

    if v_kind = 'add_slot' then
      if coalesce(op ->> 'ref', '') !~ '^[A-Za-z0-9_-]{1,20}$' or refs ? (op ->> 'ref') then
        raise exception 'INVALID_CHANGE:invalid slot reference' using errcode = 'P0001';
      end if;
      insert into public.time_slots (tracker_id, user_id, start_time, end_time)
      values (p_tracker, p_user, (op ->> 'start')::time, (op ->> 'end')::time)
      returning * into v_srow;
      refs := refs || jsonb_build_object(op ->> 'ref', v_srow.id);
      inverse := jsonb_build_array(jsonb_build_object('op', 'delete_slot', 'slot', v_srow.id)) || inverse;

    elsif v_kind = 'add_task' then
      insert into public.tasks (tracker_id, user_id, time_slot_id, day_of_week, title, description, category)
      values (p_tracker, p_user, v_slot, v_day,
              btrim(regexp_replace(coalesce(op ->> 'title', ''), '\s+', ' ', 'g')),
              nullif(btrim(coalesce(op ->> 'description', '')), ''),
              coalesce(op ->> 'category', 'other'))
      returning * into v_row;
      inverse := jsonb_build_array(jsonb_build_object('op', 'delete_task', 'task', v_row.id)) || inverse;

    elsif v_kind = 'move_task' then
      select * into v_row from public.tasks k
       where k.id = (op ->> 'task')::uuid and k.tracker_id = p_tracker and k.user_id = p_user;
      if not found then
        raise exception 'INVALID_CHANGE:unknown task' using errcode = 'P0001';
      end if;
      update public.tasks set time_slot_id = v_slot, day_of_week = v_day where id = v_row.id;
      inverse := jsonb_build_array(jsonb_build_object('op', 'move_task', 'task', v_row.id, 'slot', v_row.time_slot_id, 'day', v_row.day_of_week)) || inverse;

    elsif v_kind = 'update_task' then
      select * into v_row from public.tasks k
       where k.id = (op ->> 'task')::uuid and k.tracker_id = p_tracker and k.user_id = p_user;
      if not found then
        raise exception 'INVALID_CHANGE:unknown task' using errcode = 'P0001';
      end if;
      update public.tasks
         set title = btrim(regexp_replace(coalesce(op ->> 'title', v_row.title), '\s+', ' ', 'g')),
             category = coalesce(op ->> 'category', v_row.category),
             description = case when op ? 'description' then nullif(btrim(coalesce(op ->> 'description', '')), '') else v_row.description end
       where id = v_row.id;
      inverse := jsonb_build_array(jsonb_build_object('op', 'update_task', 'task', v_row.id, 'title', v_row.title,
                   'category', v_row.category, 'description', v_row.description)) || inverse;

    elsif v_kind = 'delete_task' then
      delete from public.tasks k
       where k.id = (op ->> 'task')::uuid and k.tracker_id = p_tracker and k.user_id = p_user
      returning * into v_row;
      if not found then
        raise exception 'INVALID_CHANGE:unknown task' using errcode = 'P0001';
      end if;
      inverse := jsonb_build_array(jsonb_build_object('op', 'add_task', 'slot', v_row.time_slot_id, 'day', v_row.day_of_week,
                   'title', v_row.title, 'category', v_row.category, 'description', v_row.description)) || inverse;

    elsif v_kind = 'delete_slot' then
      if exists (select 1 from public.tasks k where k.time_slot_id = v_slot) then
        raise exception 'INVALID_CHANGE:time slot is not empty' using errcode = 'P0001';
      end if;
      delete from public.time_slots where id = v_slot returning * into v_srow;
      inverse := jsonb_build_array(jsonb_build_object('op', 'add_slot', 'ref', left(replace(v_srow.id::text, '-', ''), 20),
                   'start', v_srow.start_time::text, 'end', v_srow.end_time::text)) || inverse;

    else
      raise exception 'INVALID_CHANGE:unknown step' using errcode = 'P0001';
    end if;
  end loop;
  return inverse;
end;
$$;
revoke execute on function public.tt_apply_ops(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Student timetables for their class teacher
-- ---------------------------------------------------------------------
-- The student's user id when the caller may edit their personal timetables:
-- caller is the class teacher of a (non-archived) class the student is
-- enrolled in, with edit_student_timetables; the student is active.
create or replace function public.student_timetable_owner(p_student uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.institution_memberships;
begin
  select * into s from public.institution_memberships where id = p_student;
  if s.id is null or s.role <> 'student' or s.status <> 'active' or s.user_id is null then
    return null;
  end if;
  if public.inst_role(s.institution_id) is distinct from 'class_teacher'
     or not public.has_inst_perm(s.institution_id, 'edit_student_timetables') then
    return null;
  end if;
  if not exists (
    select 1 from public.class_enrollments e
      join public.classes c on c.id = e.class_id
     where e.student_id = s.id and not c.archived
       and c.class_teacher_id = public.my_membership_id(s.institution_id)) then
    return null;
  end if;
  return s.user_id;
end;
$$;
revoke execute on function public.student_timetable_owner(uuid) from public, anon, authenticated;

-- Timetables (slots and activities only — no ticks or progress) of one student.
create or replace function public.teacher_student_timetables(p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.student_timetable_owner(p_student);
begin
  if v_user is null then
    raise exception 'NOT_ALLOWED:You can only see the timetables of students in your class.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'student', (select display_name from public.institution_memberships where id = p_student),
    'timetables', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'version', public.timetable_version(t.id),
        'slots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'start_time', s.start_time, 'end_time', s.end_time) order by s.start_time)
                             from public.time_slots s where s.tracker_id = t.id), '[]'::jsonb),
        'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'time_slot_id', k.time_slot_id, 'day_of_week', k.day_of_week,
                                  'title', k.title, 'category', k.category, 'description', k.description) order by k.created_at)
                             from public.tasks k where k.tracker_id = t.id), '[]'::jsonb),
        'history', coalesce((select jsonb_agg(jsonb_build_object('summary', h.summary, 'source', h.source, 'actor_name', h.actor_name,
                                  'undone', h.undone_at is not null, 'created_at', h.created_at) order by h.created_at desc)
                               from (select * from public.timetable_changes x where x.tracker_id = t.id order by x.created_at desc limit 10) h), '[]'::jsonb)
      ) order by t.created_at)
      from public.trackers t where t.user_id = v_user), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.teacher_student_timetables(uuid) from public, anon;
grant execute on function public.teacher_student_timetables(uuid) to authenticated;

-- Applies a teacher's edit to a student's timetable (p_tracker null = new timetable p_new_name).
create or replace function public.teacher_apply_timetable_change(
  p_student uuid, p_tracker uuid, p_new_name text, p_base_version text, p_summary text, p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  v_user    uuid := public.student_timetable_owner(p_student);
  v_inst    uuid;
  v_name    text;
  v_tracker uuid := p_tracker;
  v_tname   text;
  v_before  text;
  v_inverse jsonb;
  v_after   text;
  v_change  uuid;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_user is null then
    raise exception 'NOT_ALLOWED:You can only edit the timetables of students in your class.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_summary, ''))) not between 1 and 300 then
    raise exception 'INVALID_CHANGE:summary' using errcode = 'P0001';
  end if;
  select s.institution_id into v_inst from public.institution_memberships s where s.id = p_student;
  select m.display_name into v_name from public.institution_memberships m where m.institution_id = v_inst and m.user_id = uid;

  if v_tracker is null then
    begin
      insert into public.trackers (user_id, name) values (v_user, btrim(coalesce(p_new_name, '')))
      returning id, name into v_tracker, v_tname;
    exception when raise_exception then
      if sqlerrm like 'PLAN_LIMIT:%' then
        raise exception 'INVALID_CHANGE:the student can’t have another timetable on their plan' using errcode = 'P0001';
      end if;
      raise;
    end;
  else
    select t.name into v_tname from public.trackers t where t.id = v_tracker and t.user_id = v_user for update;
    if not found then
      raise exception 'INVALID_CHANGE:unknown timetable' using errcode = 'P0001';
    end if;
    v_before := public.timetable_version(v_tracker);
    if p_base_version is null or p_base_version <> v_before then
      raise exception 'STALE_TIMETABLE' using errcode = 'P0001';
    end if;
  end if;

  v_inverse := public.tt_apply_ops(v_tracker, v_user, p_ops);
  v_after := public.timetable_version(v_tracker);

  insert into public.timetable_changes (user_id, tracker_id, source, summary, ops, inverse, before_version, after_version, actor_id, actor_name)
  values (v_user, v_tracker, 'teacher', btrim(p_summary), p_ops, case when p_tracker is null then null else v_inverse end,
          v_before, v_after, uid, left(v_name, 80))
  returning id into v_change;

  insert into public.audit_log (institution_id, actor_id, action, record_type, record_id, new_value, metadata)
  values (v_inst, uid, case when p_tracker is null then 'insert' else 'update' end, 'student_timetable', v_tracker::text,
          jsonb_build_object('summary', btrim(p_summary), 'steps', jsonb_array_length(p_ops)),
          jsonb_build_object('student_membership', p_student, 'change_id', v_change));

  perform public.notify(v_user, v_inst, 'timetable_changed',
    'Your class teacher changed your timetable',
    coalesce(v_name, 'Your class teacher') || ' changed “' || v_tname || '”: ' || btrim(p_summary)
      || case when p_tracker is null then '.' else '. You can undo it from Timetable assistant → History.' end,
    '/dashboard', null);

  return jsonb_build_object('tracker_id', v_tracker, 'change_id', v_change, 'version', v_after);
end;
$$;
revoke execute on function public.teacher_apply_timetable_change(uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.teacher_apply_timetable_change(uuid, uuid, text, text, text, jsonb) to authenticated;

-- Students whose personal timetables I may edit (for the Classes page).
create or replace function public.my_editable_students()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct e.student_id
    from public.class_enrollments e
    join public.classes c on c.id = e.class_id
   where not c.archived
     and c.class_teacher_id = public.my_membership_id(c.institution_id)
     and public.student_timetable_owner(e.student_id) is not null;
$$;
revoke execute on function public.my_editable_students() from public, anon;
grant execute on function public.my_editable_students() to authenticated;
