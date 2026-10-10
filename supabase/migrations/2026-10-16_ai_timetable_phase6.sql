-- =====================================================================
-- Phase 6: AI timetable assistant.
--
-- * timetable_preferences: the student's saved answers to the "needs check"
--   (goals, wake/sleep, commitments…), reused and editable next time.
-- * apply_timetable_change(): the only way AI proposals, voice commands and
--   rescheduling reach a timetable. One transaction; works only on the
--   caller's own personal timetables (institution timetables are never
--   touched); refuses a proposal made for an older version of the timetable;
--   records an append-only history row with the steps needed to undo it.
-- * undo_timetable_change(): undoes the latest change if nothing was edited
--   since.
-- * my_timetable_context(): what the AI may know without asking — the
--   student's class periods, upcoming deadlines, exams and holidays.
-- Additive. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Saved needs-check answers
-- ---------------------------------------------------------------------
create table if not exists public.timetable_preferences (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  answers    jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 8000),
  updated_at timestamptz not null default now()
);
alter table public.timetable_preferences enable row level security;
revoke all on public.timetable_preferences from anon;
drop policy if exists "own rows" on public.timetable_preferences;
create policy "own rows" on public.timetable_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.timetable_preferences to authenticated;

drop trigger if exists timetable_preferences_updated_at on public.timetable_preferences;
create trigger timetable_preferences_updated_at before update on public.timetable_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Change history (append-only for clients)
-- ---------------------------------------------------------------------
create table if not exists public.timetable_changes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  tracker_id     uuid not null,
  source         text not null check (source in ('ai_generate', 'ai_reschedule', 'voice', 'undo')),
  summary        text not null check (char_length(btrim(summary)) between 1 and 300),
  ops            jsonb not null check (jsonb_typeof(ops) = 'array'),
  -- steps that reverse this change (null = can't be undone, e.g. a new timetable)
  inverse        jsonb check (inverse is null or jsonb_typeof(inverse) = 'array'),
  before_version text,
  after_version  text not null,
  undo_of        uuid references public.timetable_changes (id) on delete set null,
  undone_at      timestamptz,
  created_at     timestamptz not null default now(),
  foreign key (tracker_id, user_id) references public.trackers (id, user_id) on delete cascade
);
create index if not exists timetable_changes_tracker_idx on public.timetable_changes (tracker_id, created_at desc);
create index if not exists timetable_changes_user_idx on public.timetable_changes (user_id);

alter table public.timetable_changes enable row level security;
revoke all on public.timetable_changes from anon, authenticated;
drop policy if exists "own" on public.timetable_changes;
create policy "own" on public.timetable_changes for select to authenticated using (user_id = (select auth.uid()));
grant select (id, tracker_id, source, summary, ops, inverse, before_version, after_version, undo_of, undone_at, created_at)
  on public.timetable_changes to authenticated;

-- ---------------------------------------------------------------------
-- Version of a timetable's contents: changes whenever a slot or task does.
-- Invoker rights: returns null for timetables the caller can't see.
-- ---------------------------------------------------------------------
create or replace function public.timetable_version(p_tracker uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from public.trackers t where t.id = p_tracker) then md5(
    coalesce((select string_agg(s.id::text || '|' || s.start_time::text || '|' || s.end_time::text, ';' order by s.id)
              from public.time_slots s where s.tracker_id = p_tracker), '')
    || '#' ||
    coalesce((select string_agg(k.id::text || '|' || k.time_slot_id::text || '|' || k.day_of_week::text || '|' || k.title
                                || '|' || k.category || '|' || coalesce(k.description, ''), ';' order by k.id)
              from public.tasks k where k.tracker_id = p_tracker), '')
  ) end;
$$;
revoke execute on function public.timetable_version(uuid) from public, anon;
grant execute on function public.timetable_version(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Applies a list of steps to one of the user's timetables and returns the
-- steps that undo them. Internal: callers check ownership first.
--   {"op":"add_slot","ref":"s1","start":"16:00","end":"17:00"}
--   {"op":"add_task","slot":"<uuid>"|"slot_ref":"s1","day":1,"title":"…","category":"study","description":null}
--   {"op":"move_task","task":"<uuid>","slot":"<uuid>"|"slot_ref":"s1","day":6}
--   {"op":"delete_task","task":"<uuid>"}
--   {"op":"delete_slot","slot":"<uuid>"}   (empty slots only)
-- ---------------------------------------------------------------------
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
-- Saves an AI proposal / voice command / rescheduling.
-- p_tracker null = create a new timetable called p_new_name.
-- p_base_version: timetable_version() the proposal was made for; required for
-- existing timetables so a proposal can't overwrite newer edits.
-- ---------------------------------------------------------------------
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
  if p_source not in ('ai_generate', 'ai_reschedule', 'voice') then
    raise exception 'INVALID_CHANGE:unknown source' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_summary, ''))) not between 1 and 300 then
    raise exception 'INVALID_CHANGE:summary' using errcode = 'P0001';
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

-- Undo the latest change of a timetable, only if nothing was edited since.
create or replace function public.undo_timetable_change(p_change uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid  uuid := auth.uid();
  c    public.timetable_changes;
  v_inverse jsonb;
  v_after text;
  v_id uuid;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select * into c from public.timetable_changes where id = p_change and user_id = uid;
  if not found then
    raise exception 'INVALID_CHANGE:unknown change' using errcode = 'P0001';
  end if;
  perform 1 from public.trackers t where t.id = c.tracker_id for update;
  if c.undone_at is not null or c.source = 'undo' or c.inverse is null then
    raise exception 'CANNOT_UNDO:This change can’t be undone.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.timetable_changes x
              where x.tracker_id = c.tracker_id and x.created_at > c.created_at and x.undone_at is null and x.source <> 'undo') then
    raise exception 'CANNOT_UNDO:Undo the newer changes first.' using errcode = 'P0001';
  end if;
  if public.timetable_version(c.tracker_id) is distinct from c.after_version then
    raise exception 'CANNOT_UNDO:The timetable was edited after this change, so it can’t be undone automatically.' using errcode = 'P0001';
  end if;

  v_inverse := public.tt_apply_ops(c.tracker_id, uid, c.inverse);
  v_after := public.timetable_version(c.tracker_id);
  update public.timetable_changes set undone_at = now() where id = c.id;
  insert into public.timetable_changes (user_id, tracker_id, source, summary, ops, inverse, before_version, after_version, undo_of)
  values (uid, c.tracker_id, 'undo', left('Undid: ' || c.summary, 300), c.inverse, null, c.after_version, v_after, c.id)
  returning id into v_id;
  return jsonb_build_object('tracker_id', c.tracker_id, 'change_id', v_id, 'version', v_after);
end;
$$;
revoke execute on function public.undo_timetable_change(uuid) from public, anon;
grant execute on function public.undo_timetable_change(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- What the timetable AI already knows (so it doesn't ask): for each active
-- student membership, the class periods, deadlines in the next 3 weeks,
-- exams and holidays in the next 6 weeks. Read-only.
-- ---------------------------------------------------------------------
create or replace function public.my_timetable_context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mem as (
    select m.id, m.institution_id, i.name inst_name, i.timezone
      from public.institution_memberships m
      join public.institutions i on i.id = m.institution_id
     where m.user_id = auth.uid() and m.role = 'student' and m.status = 'active' and i.status = 'active'
  ), cls as (
    select c.id, c.grade, c.name, c.institution_id
      from public.class_enrollments e
      join mem on mem.id = e.student_id
      join public.classes c on c.id = e.class_id and not c.archived
  )
  select jsonb_build_object(
    'student', exists (select 1 from mem),
    'institution', (select inst_name from mem limit 1),
    'timezone', (select timezone from mem limit 1),
    'classes', coalesce((select jsonb_agg(name order by name) from cls), '[]'::jsonb),
    'periods', coalesce((
      select jsonb_agg(jsonb_build_object('day', p.day_of_week, 'start', to_char(p.start_time, 'HH24:MI'),
                       'end', to_char(p.end_time, 'HH24:MI'), 'subject', coalesce(s.name, p.label))
                       order by p.day_of_week, p.start_time)
        from public.class_periods p join cls on cls.id = p.class_id
        left join public.subjects s on s.id = p.subject_id), '[]'::jsonb),
    'deadlines', coalesce((
      select jsonb_agg(jsonb_build_object('title', a.title, 'subject', s.name, 'kind', a.kind, 'due_at', a.due_at) order by a.due_at)
        from public.assignments a join cls on cls.id = a.class_id
        join public.subjects s on s.id = a.subject_id
       where a.status = 'published' and a.due_at between now() and now() + interval '21 days'), '[]'::jsonb),
    'exams', coalesce((
      select jsonb_agg(distinct jsonb_build_object('title', e.title, 'subject', s.name, 'starts_on', e.starts_on, 'ends_on', e.ends_on,
                       'start', to_char(e.start_time, 'HH24:MI'), 'end', to_char(e.end_time, 'HH24:MI')))
        from public.calendar_events e join cls on cls.institution_id = e.institution_id
        left join public.subjects s on s.id = e.subject_id
       where e.kind = 'exam' and e.status = 'scheduled' and public.event_applies(e.class_id, e.grade, cls.id, cls.grade)
         and e.ends_on >= current_date and e.starts_on <= current_date + 42), '[]'::jsonb),
    'holidays', coalesce((
      select jsonb_agg(distinct jsonb_build_object('title', e.title, 'starts_on', e.starts_on, 'ends_on', e.ends_on))
        from public.calendar_events e join cls on cls.institution_id = e.institution_id
       where e.kind = 'holiday' and e.status = 'scheduled' and public.event_applies(e.class_id, e.grade, cls.id, cls.grade)
         and e.ends_on >= current_date and e.starts_on <= current_date + 42), '[]'::jsonb)
  );
$$;
revoke execute on function public.my_timetable_context() from public, anon;
grant execute on function public.my_timetable_context() to authenticated;
