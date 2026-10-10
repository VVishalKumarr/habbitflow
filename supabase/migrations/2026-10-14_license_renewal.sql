-- =====================================================================
-- Institution licence renewal: yearly licences and expiry reminders.
--
-- * Institution licences always run for one year (to the same date next
--   year). Renewing means activating a new key; it starts when the current
--   licence ends, so nothing is lost by renewing early.
-- * A daily job reminds the institution's principal/director — and the
--   platform owner, who issues the new key — 30 days and 7 days before the
--   licence ends and on the day it ends (grace period starts). No reminder is
--   sent once a renewal is activated. Each reminder is sent once (dedupe key).
-- Additive. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Generation: institution keys are always one year
-- ---------------------------------------------------------------------
create or replace function public.generate_license_codes(
  p_actor uuid, p_kind text, p_plan text, p_count integer, p_duration_days integer,
  p_max_redemptions integer default 1, p_redeem_by timestamptz default null, p_institution uuid default null,
  p_note text default null, p_grace_days integer default 7, p_limits_override jsonb default '{}'::jsonb,
  p_extra_features text[] default '{}'
)
returns table (id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c text;
  cid uuid;
  prefix text;
  days integer := p_duration_days;
begin
  if p_kind not in ('institution', 'individual', 'gift') then
    raise exception 'Choose institution, individual or gift.';
  end if;
  if not exists (select 1 from public.plans where plans.id = p_plan and plans.id <> 'free') then
    raise exception 'Choose a paid plan.';
  end if;
  if p_count is null or p_count not between 1 and 500 then
    raise exception 'Generate between 1 and 500 codes at a time.';
  end if;
  if p_kind = 'institution' then
    -- Institution licences are yearly; any length passed in is ignored.
    days := 365;
  elsif days is null or days not between 1 and 3660 then
    raise exception 'Duration must be 1 to 3660 days.';
  end if;
  if p_redeem_by is not null and p_redeem_by <= now() then
    raise exception 'The redeem-by date must be in the future.';
  end if;
  if p_kind = 'institution' then
    if p_institution is null or not exists (select 1 from public.institutions where institutions.id = p_institution) then
      raise exception 'Choose the institution this licence is for.';
    end if;
    if p_count <> 1 or coalesce(p_max_redemptions, 1) <> 1 then
      raise exception 'Institution licence keys are generated one at a time and activate once.';
    end if;
  elsif p_institution is not null then
    raise exception 'Only institution licences belong to an institution.';
  end if;
  perform public.check_limits_override(coalesce(p_limits_override, '{}'::jsonb));
  perform public.check_feature_keys(p_extra_features);
  if p_kind <> 'institution' and (coalesce(p_limits_override, '{}'::jsonb) <> '{}'::jsonb or cardinality(coalesce(p_extra_features, '{}')) > 0) then
    raise exception 'Extra limits and features apply to institution licences only.';
  end if;

  prefix := case p_kind when 'institution' then 'HFI' when 'individual' then 'HFL' else 'HFG' end;
  for i in 1..p_count loop
    c := public.new_code(prefix);
    insert into public.license_codes (kind, code_hash, code_hint, plan, duration_days, max_redemptions, redeem_by,
                                      institution_id, grace_days, limits_override, extra_features, note, created_by)
    values (p_kind, public.code_hash(c), right(public.normalize_code(c), 4), p_plan, days,
            coalesce(p_max_redemptions, 1), p_redeem_by, p_institution, coalesce(p_grace_days, 7),
            coalesce(p_limits_override, '{}'::jsonb), coalesce(p_extra_features, '{}'), nullif(btrim(coalesce(p_note, '')), ''), p_actor)
    returning license_codes.id into cid;
    id := cid;
    code := c;
    return next;
  end loop;

  perform set_config('habitflow.actor', coalesce(p_actor::text, ''), true);
  perform public.write_audit(p_institution, 'generate', 'license_code', null, null,
    jsonb_build_object('kind', p_kind, 'plan', p_plan, 'count', p_count, 'duration_days', days,
                       'max_redemptions', coalesce(p_max_redemptions, 1), 'redeem_by', p_redeem_by),
    p_note, jsonb_build_object('via', case when p_actor is null then 'script' else 'platform_admin' end));
end;
$$;
revoke execute on function public.generate_license_codes(uuid, text, text, integer, integer, integer, timestamptz, uuid, text, integer, jsonb, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Activation: one calendar year from the start (renewals start at the end
-- of the current licence)
-- ---------------------------------------------------------------------
create or replace function public.activate_institution_license(p_inst uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  c public.license_codes;
  base timestamptz;
  lic public.institution_licenses;
begin
  if me is null or not public.has_inst_perm(p_inst, 'manage_license') then
    raise exception 'Only the principal or director can activate the licence.';
  end if;
  if public.hit_rate_limit(me::text, 'activate_license', 10, 3600) then
    raise exception 'Too many attempts. Please try again in an hour.';
  end if;
  c := public.claim_code(p_code, array['institution']);
  if c.institution_id <> p_inst then
    raise exception 'This licence key was issued for a different institution.';
  end if;
  select greatest(now(), coalesce(max(l.expires_at), now())) into base
  from public.institution_licenses l
  where l.institution_id = p_inst and l.status = 'active' and l.expires_at > now();

  insert into public.institution_licenses (institution_id, code_id, plan, limits_override, extra_features,
                                           starts_at, expires_at, grace_days, activated_by)
  values (p_inst, c.id, c.plan, c.limits_override, c.extra_features, base, base + interval '1 year', c.grace_days, me)
  returning * into lic;
  insert into public.code_redemptions (code_id, user_id, institution_id, license_id) values (c.id, me, p_inst, lic.id);
  update public.license_codes set redemption_count = redemption_count + 1 where id = c.id;
  perform public.write_audit(p_inst, 'activate', 'institution_license', lic.id::text, null,
    jsonb_build_object('plan', lic.plan, 'starts_at', lic.starts_at, 'expires_at', lic.expires_at, 'grace_days', lic.grace_days));
  return to_jsonb(lic) - 'activated_by';
end;
$$;
revoke execute on function public.activate_institution_license(uuid, text) from public, anon;
grant execute on function public.activate_institution_license(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- When does the institution's licensed access end? (latest active licence,
-- including a renewal that hasn't started yet)
-- ---------------------------------------------------------------------
create or replace function public.institution_license_end(p_inst uuid)
returns public.institution_licenses
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.institution_licenses l
  where l.institution_id = p_inst and l.status = 'active'
  order by l.expires_at desc limit 1;
$$;
revoke execute on function public.institution_license_end(uuid) from public, anon, authenticated;

-- state: active · expiring (≤ 30 days left, no renewal yet) · grace · expired · none
create or replace function public.institution_license_status(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cur public.institution_licenses;
  last public.institution_licenses;
  st text;
begin
  if not public.has_inst_perm(p_inst, 'manage_license') then
    raise exception 'Only the principal or director can view the licence.';
  end if;
  select * into cur from public.institution_licenses l
  where l.institution_id = p_inst and l.status = 'active' and l.starts_at <= now()
  order by l.expires_at desc limit 1;
  last := public.institution_license_end(p_inst);
  st := case
    when last.id is null then 'none'
    when now() >= last.expires_at + make_interval(days => last.grace_days) then 'expired'
    when now() >= last.expires_at then 'grace'
    when last.expires_at - now() <= interval '30 days' then 'expiring'
    else 'active' end;
  return jsonb_build_object(
    'state', st,
    'plan', coalesce(cur.plan, last.plan),
    'plan_name', (select name from public.plans where id = coalesce(cur.plan, last.plan)),
    'expires_at', last.expires_at,
    'days_left', greatest(0, ceil(extract(epoch from (last.expires_at - now())) / 86400))::integer,
    'renewal_scheduled', last.starts_at > now(),
    'grace_ends_at', last.expires_at + make_interval(days => last.grace_days),
    'members_covered', (select count(*) from public.institution_memberships m
                        where m.institution_id = p_inst and m.status = 'active' and m.role <> 'parent'),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'plan_name', p.name, 'starts_at', l.starts_at, 'expires_at', l.expires_at, 'status', l.status,
        'activated_at', l.activated_at, 'revoked_reason', l.revoked_reason,
        'activated_by', (select m.display_name from public.institution_memberships m
                         where m.institution_id = p_inst and m.user_id = l.activated_by limit 1))
        order by l.activated_at desc)
      from public.institution_licenses l join public.plans p on p.id = l.plan
      where l.institution_id = p_inst), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.institution_license_status(uuid) from public, anon;
grant execute on function public.institution_license_status(uuid) to authenticated;

create or replace function public.platform_licenses()
returns table (
  id uuid, institution_id uuid, institution_name text, plan_name text, starts_at timestamptz, expires_at timestamptz,
  grace_days integer, status text, state text, activated_at timestamptz, revoked_reason text, code_hint text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can view licences.';
  end if;
  return query
  select l.id, l.institution_id, i.name, p.name, l.starts_at, l.expires_at, l.grace_days, l.status,
         case when l.status = 'revoked' then 'revoked'
              when now() < l.starts_at then 'scheduled'
              when now() < l.expires_at and l.expires_at - now() <= interval '30 days'
                   and not exists (select 1 from public.institution_licenses r where r.institution_id = l.institution_id
                                   and r.status = 'active' and r.expires_at > l.expires_at) then 'expiring'
              when now() < l.expires_at then 'active'
              when now() < l.expires_at + make_interval(days => l.grace_days) then 'grace'
              else 'expired' end,
         l.activated_at, l.revoked_reason, c.code_hint
  from public.institution_licenses l
  join public.institutions i on i.id = l.institution_id
  join public.plans p on p.id = l.plan
  left join public.license_codes c on c.id = l.code_id
  order by l.expires_at desc;
end;
$$;
revoke execute on function public.platform_licenses() from public, anon;
grant execute on function public.platform_licenses() to authenticated;

-- ---------------------------------------------------------------------
-- Daily reminders
-- ---------------------------------------------------------------------
create or replace function public.send_license_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
  stage text;
  title text;
  body text;
  ends text;
begin
  for r in
    select i.id inst, i.name, i.timezone, l.*
    from public.institutions i
    cross join lateral public.institution_license_end(i.id) l
    where i.status = 'active' and l.id is not null
      and now() >= l.expires_at - interval '30 days'
      and now() < l.expires_at + make_interval(days => l.grace_days)
  loop
    ends := to_char(r.expires_at at time zone r.timezone, 'DD Mon YYYY');
    if now() >= r.expires_at then
      stage := 'ended';
      title := 'Licence expired: ' || r.name;
      body := 'The licence ended on ' || ends || '. Licensed features stop on '
              || to_char((r.expires_at + make_interval(days => r.grace_days)) at time zone r.timezone, 'DD Mon YYYY')
              || ' unless a renewal key is activated. No records are deleted.';
    elsif now() >= r.expires_at - interval '7 days' then
      stage := 'd7';
      title := 'Licence ends in under a week: ' || r.name;
      body := 'The licence ends on ' || ends || '. Activate a renewal key to continue without interruption.';
    else
      stage := 'd30';
      title := 'Licence ends in a month: ' || r.name;
      body := 'The licence ends on ' || ends || '. Activate a renewal key to continue for another year; it starts when the current licence ends.';
    end if;

    -- Principal and director (the only roles that can activate a key).
    perform public.notify(m.user_id, r.inst, 'license_expiring', title, body, '/school/settings',
                          'lic:' || stage || ':' || r.id)
    from public.institution_memberships m
    where m.institution_id = r.inst and m.status = 'active' and m.user_id is not null and m.role in ('principal', 'director');

    -- Platform owner, who issues the renewal key.
    perform public.notify(pa.user_id, r.inst, 'license_expiring', title, 'Generate a renewal key for this institution. ' || body,
                          '/admin', 'lic:' || stage || ':' || r.id)
    from public.platform_admins pa;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.send_license_reminders() from public, anon, authenticated;

select cron.unschedule('license-reminders') where exists (select 1 from cron.job where jobname = 'license-reminders');
select cron.schedule('license-reminders', '30 3 * * *', 'select public.send_license_reminders()');
