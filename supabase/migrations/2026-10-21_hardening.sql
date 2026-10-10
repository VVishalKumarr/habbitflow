-- =====================================================================
-- Phase 9 hardening.
--
-- Trigger functions can't do anything useful when called directly, but they
-- don't need to be callable at all: revoke EXECUTE from every client role.
-- (Postgres checks EXECUTE only when a trigger is created, not when it
-- fires, so the triggers keep working.)
-- Safe to re-run; also covers trigger functions added later.
-- =====================================================================
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Utilities only used inside server functions: not callable from the app.
revoke execute on function public.ai_least(integer, integer) from public, anon, authenticated;
revoke execute on function public.current_actor() from public, anon, authenticated;
revoke execute on function public.normalize_code(text) from public, anon, authenticated;

-- An institution's settings (grading scale, limits, weights…) only for its
-- members, the platform owner, and server-side callers (no signed-in user).
-- Found by the Phase 9 function sweep: any signed-in user could read them.
create or replace function public.institution_settings(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and public.inst_role(p_inst) is null and not public.is_platform_admin()
     and not exists (select 1 from public.institution_memberships m where m.institution_id = p_inst and m.user_id = auth.uid()) then
    raise exception 'NOT_ALLOWED:Not a member of this institution.' using errcode = '42501';
  end if;
  return jsonb_build_object(
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
end;
$$;
