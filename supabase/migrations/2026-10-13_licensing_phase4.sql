-- =====================================================================
-- Phase 4: entitlements, institution licences, individual licence codes,
-- gift codes, friend limits.
--
-- * One place decides what a user may do: entitlement_sources(user) lists
--   every active source (individual subscriptions — payments, trials, gift
--   codes, manual grants — and the licence of each institution where the
--   user is an active staff member or student). effective_entitlements()
--   merges them: features are the union, each limit is the most generous
--   (null = unlimited). plan_of / plan_limit / has_feature now read from it,
--   so every existing check (trackers, friends, history, exports, themes…)
--   honours licences and gift codes without further changes.
-- * Codes are 80-bit random strings from pgcrypto, shown once and stored as
--   SHA-256 hashes. Redemption locks the code row, so a limited code can't be
--   over-redeemed by simultaneous requests.
-- * New tables have no client grants: everything goes through functions.
-- Additive. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Plans: new friend limits (Free 1, Plus 3, Pro unlimited) and the
-- AI-guided timetable feature for Plus and Pro. Values only change if they
-- are still the old defaults, so later edits are never overwritten.
-- ---------------------------------------------------------------------
update public.plans set limits = jsonb_set(limits, '{friends}', '1') where id = 'free' and limits -> 'friends' = '3';
update public.plans set limits = jsonb_set(limits, '{friends}', '3') where id = 'plus' and limits -> 'friends' = '10';
update public.plans set limits = jsonb_set(limits, '{friends}', 'null') where id = 'pro' and limits -> 'friends' = '50';
update public.plans set features = features || array['ai_guided_timetable']
  where id in ('plus', 'pro') and not ('ai_guided_timetable' = any (features));

-- Gift codes and licence codes create subscriptions with provider 'gift'.
alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check
  check (provider in ('razorpay', 'stripe', 'lemonsqueezy', 'google_play', 'trial', 'manual', 'gift'));

-- ---------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------
create table if not exists public.license_codes (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('institution', 'individual', 'gift')),
  code_hash        text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint        text not null check (char_length(code_hint) = 4),
  plan             text not null references public.plans (id),
  duration_days    integer not null check (duration_days between 1 and 3660),
  max_redemptions  integer not null default 1 check (max_redemptions between 1 and 100000),
  redemption_count integer not null default 0,
  redeem_by        timestamptz,
  institution_id   uuid references public.institutions (id) on delete cascade,
  grace_days       integer not null default 7 check (grace_days between 0 and 60),
  limits_override  jsonb not null default '{}'::jsonb check (jsonb_typeof(limits_override) = 'object'),
  extra_features   text[] not null default '{}',
  note             text check (note is null or char_length(note) <= 200),
  status           text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at       timestamptz,
  revoked_reason   text check (revoked_reason is null or char_length(revoked_reason) <= 300),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  check (redemption_count between 0 and max_redemptions),
  check ((kind = 'institution') = (institution_id is not null)),
  check (kind <> 'institution' or max_redemptions = 1)
);
create index if not exists license_codes_kind_idx on public.license_codes (kind, created_at desc);
create index if not exists license_codes_inst_idx on public.license_codes (institution_id);

create table if not exists public.institution_licenses (
  id              uuid primary key default gen_random_uuid(),
  institution_id  uuid not null references public.institutions (id) on delete cascade,
  code_id         uuid references public.license_codes (id) on delete set null,
  plan            text not null references public.plans (id),
  limits_override jsonb not null default '{}'::jsonb,
  extra_features  text[] not null default '{}',
  starts_at       timestamptz not null,
  expires_at      timestamptz not null,
  grace_days      integer not null default 7 check (grace_days between 0 and 60),
  status          text not null default 'active' check (status in ('active', 'revoked')),
  activated_by    uuid references auth.users (id) on delete set null,
  activated_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_reason  text check (revoked_reason is null or char_length(revoked_reason) <= 300),
  check (expires_at > starts_at)
);
create index if not exists institution_licenses_inst_idx on public.institution_licenses (institution_id, expires_at desc);

create table if not exists public.code_redemptions (
  id              uuid primary key default gen_random_uuid(),
  code_id         uuid not null references public.license_codes (id) on delete cascade,
  user_id         uuid references auth.users (id) on delete set null,
  institution_id  uuid references public.institutions (id) on delete set null,
  subscription_id uuid references public.subscriptions (id) on delete set null,
  license_id      uuid references public.institution_licenses (id) on delete set null,
  redeemed_at     timestamptz not null default now()
);
create unique index if not exists code_redemptions_once_idx on public.code_redemptions (code_id, user_id) where user_id is not null;
create index if not exists code_redemptions_user_idx on public.code_redemptions (user_id);

alter table public.license_codes enable row level security;
alter table public.institution_licenses enable row level security;
alter table public.code_redemptions enable row level security;
revoke all on public.license_codes, public.institution_licenses, public.code_redemptions from anon, authenticated;

-- Platform owner can read licence history in the audit log.
drop policy if exists "audit: read" on public.audit_log;
create policy "audit: read" on public.audit_log for select to authenticated
  using ((institution_id is not null and public.has_inst_perm(institution_id, 'view_audit'))
         or (public.is_platform_admin() and record_type in ('institutions', 'institution_email_allowlist', 'platform_admins',
                                                            'license_code', 'institution_license', 'plan', 'subscription')));

-- ---------------------------------------------------------------------
-- Entitlements
-- ---------------------------------------------------------------------
create or replace function public.subscription_is_current(s public.subscriptions)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (s.status in ('active', 'trialing', 'past_due') and (s.expires_at is null or s.expires_at > now()))
      or (s.status = 'cancelled' and s.expires_at > now());
$$;

-- Every active source of features for a user (not including the free base).
create or replace function public.entitlement_sources(p_user uuid)
returns table (
  source text, ref_id uuid, plan_id text, plan_name text, rank smallint, limits jsonb, features text[],
  expires_at timestamptz, in_grace boolean, institution_id uuid, institution_name text, provider text, status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'subscription', s.id, p.id, p.name, p.rank, p.limits, p.features, s.expires_at, false, null::uuid, null::text, s.provider, s.status
  from public.subscriptions s
  join public.plans p on p.id = s.plan
  where s.user_id = p_user and public.subscription_is_current(s)
  union all
  select 'institution', l.id, p.id, p.name, p.rank, p.limits || l.limits_override,
         array(select distinct f from unnest(p.features || l.extra_features) f order by f),
         l.expires_at, now() >= l.expires_at, i.id, i.name, 'institution', 'active'
  from public.institution_licenses l
  join public.institutions i on i.id = l.institution_id and i.status = 'active'
  join public.institution_memberships m on m.institution_id = l.institution_id and m.user_id = p_user
                                       and m.status = 'active' and m.role <> 'parent'
  join public.plans p on p.id = l.plan
  where l.status = 'active' and l.starts_at <= now()
    and now() < l.expires_at + make_interval(days => l.grace_days);
$$;
revoke execute on function public.entitlement_sources(uuid) from public, anon, authenticated;

-- Merged limits: null (unlimited) wins, otherwise the highest value. The free
-- plan is always the base, so a missing key never means "unlimited" by accident.
create or replace function public.effective_limits(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- A key missing from a paid source means unlimited there (as plan_limit always did).
  with src as (
    select limits, false as base from public.entitlement_sources(p_user)
    union all
    select limits, true from public.plans where id = 'free'
  ),
  keys as (select distinct jsonb_object_keys(limits) k from src where jsonb_typeof(limits) = 'object')
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from (
    select keys.k,
      case when bool_or((not src.base and not (src.limits ? keys.k)) or src.limits -> keys.k = 'null'::jsonb)
           then 'null'::jsonb
           else to_jsonb(max((src.limits ->> keys.k)::integer)) end as v
    from keys cross join src
    group by keys.k
  ) merged;
$$;
revoke execute on function public.effective_limits(uuid) from public, anon, authenticated;

create or replace function public.effective_features(p_user uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array(
    select distinct f from (
      select unnest(features) f from public.entitlement_sources(p_user)
      union all
      select unnest(features) from public.plans where id = 'free'
    ) x order by f
  ), '{}');
$$;
revoke execute on function public.effective_features(uuid) from public, anon, authenticated;

-- The highest-ranked plan from any source, else 'free'.
create or replace function public.plan_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select plan_id from public.entitlement_sources(p_user) order by rank desc, source desc limit 1), 'free');
$$;
revoke execute on function public.plan_of(uuid) from public, anon, authenticated;

-- null = unlimited
create or replace function public.plan_limit(p_user uuid, p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (public.effective_limits(p_user) ->> p_key)::integer;
$$;
revoke execute on function public.plan_limit(uuid, text) from public, anon, authenticated;

create or replace function public.has_feature(p_user uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_feature = any (public.effective_features(p_user));
$$;
revoke execute on function public.has_feature(uuid, text) from public, anon, authenticated;

-- What the signed-in user is entitled to (drives the UI; the database
-- enforces the same rules independently).
-- state: FREE (never paid) · TRIAL · ACTIVE (any current source) · EXPIRED (had one, now free)
-- source: 'subscription' | 'institution' | null
create or replace function public.my_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  top record;
  sub public.subscriptions;
  p public.plans;
  had_any boolean;
  state text;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  select * into top from public.entitlement_sources(me) order by rank desc, source desc,
    coalesce(expires_at, 'infinity'::timestamptz) desc limit 1;
  select * into p from public.plans where id = coalesce(top.plan_id, 'free');
  had_any := exists (select 1 from public.subscriptions where user_id = me and plan <> 'free')
          or exists (select 1 from public.code_redemptions where user_id = me);

  if top.source = 'subscription' then
    select * into sub from public.subscriptions where id = top.ref_id;
    state := case when sub.status = 'trialing' then 'TRIAL' else 'ACTIVE' end;
  elsif top.source = 'institution' then
    state := 'ACTIVE';
  elsif had_any then
    state := 'EXPIRED';
  else
    state := 'FREE';
  end if;

  return jsonb_build_object(
    'plan', p.id,
    'plan_name', p.name,
    'rank', p.rank,
    'state', state,
    'source', top.source,
    'institution_name', top.institution_name,
    'grace', coalesce(top.in_grace, false),
    'provider', coalesce(sub.provider, case when top.source = 'institution' then 'institution' end),
    'status', sub.status,
    'expires_at', coalesce(sub.expires_at, top.expires_at),
    'cancel_at_period_end', coalesce(sub.cancel_at_period_end, false),
    'limits', public.effective_limits(me),
    'features', to_jsonb(public.effective_features(me)),
    'trial_available', not exists (select 1 from public.subscriptions where user_id = me and provider <> 'gift')
                       and exists (select 1 from public.plans where trial_days > 0)
  );
end;
$$;
revoke execute on function public.my_entitlements() from public, anon;
grant execute on function public.my_entitlements() to authenticated;

-- Redeeming a gift code doesn't use up the free trial.
create or replace function public.start_trial()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  tp public.plans;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  select * into tp from public.plans where trial_days > 0 order by rank desc limit 1;
  if tp.id is null then
    raise exception 'Free trials are not available right now.';
  end if;
  if exists (select 1 from public.subscriptions where user_id = me and provider <> 'gift') then
    raise exception 'Your free trial has already been used.';
  end if;
  insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at)
  values (me, 'trial', tp.id, 'trialing', now(), now() + make_interval(days => tp.trial_days));
  return public.my_entitlements();
end;
$$;
revoke execute on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

-- ---------------------------------------------------------------------
-- Code helpers
-- ---------------------------------------------------------------------
-- "HFG-7KQ2-MX9P-…" → "HFG7KQ2MX9P…" (case, spaces and dashes don't matter)
create or replace function public.normalize_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create or replace function public.code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(public.normalize_code(p_code), 'sha256'), 'hex');
$$;
revoke execute on function public.code_hash(text) from public, anon, authenticated;

-- 16 characters from a 32-letter alphabet without 0/O/1/I = 80 random bits.
create or replace function public.new_code(p_prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b bytea := extensions.gen_random_bytes(16);
  s text := '';
begin
  for i in 0..15 loop
    s := s || substr(alphabet, (get_byte(b, i) & 31) + 1, 1);
    if i in (3, 7, 11) then
      s := s || '-';
    end if;
  end loop;
  return p_prefix || '-' || s;
end;
$$;
revoke execute on function public.new_code(text) from public, anon, authenticated;

create or replace function public.check_limits_override(p jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Limits must be an object.';
  end if;
  for k, v in select * from jsonb_each(p) loop
    if k !~ '^[a-z_]{2,40}$' then
      raise exception 'Unknown limit name: %', k;
    end if;
    if not (jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and 1000000
                                          and (v #>> '{}')::numeric = floor((v #>> '{}')::numeric))) then
      raise exception 'Limit % must be a whole number or empty (unlimited).', k;
    end if;
  end loop;
end;
$$;

create or replace function public.check_feature_keys(p text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if exists (select 1 from unnest(coalesce(p, '{}')) f where f !~ '^[a-z_]{2,40}$') then
    raise exception 'Feature names use lowercase letters and underscores only.';
  end if;
end;
$$;

-- Server-only generator, used by the platform owner function below and by
-- scripts/generate-codes.mjs (which runs SQL with the project's admin token).
-- Returns the plaintext codes once; only their hashes are stored.
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
  if p_duration_days is null or p_duration_days not between 1 and 3660 then
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
    values (p_kind, public.code_hash(c), right(public.normalize_code(c), 4), p_plan, p_duration_days,
            coalesce(p_max_redemptions, 1), p_redeem_by, p_institution, coalesce(p_grace_days, 7),
            coalesce(p_limits_override, '{}'::jsonb), coalesce(p_extra_features, '{}'), nullif(btrim(coalesce(p_note, '')), ''), p_actor)
    returning license_codes.id into cid;
    id := cid;
    code := c;
    return next;
  end loop;

  perform set_config('habitflow.actor', coalesce(p_actor::text, ''), true);
  perform public.write_audit(p_institution, 'generate', 'license_code', null, null,
    jsonb_build_object('kind', p_kind, 'plan', p_plan, 'count', p_count, 'duration_days', p_duration_days,
                       'max_redemptions', coalesce(p_max_redemptions, 1), 'redeem_by', p_redeem_by),
    p_note, jsonb_build_object('via', case when p_actor is null then 'script' else 'platform_admin' end));
end;
$$;
revoke execute on function public.generate_license_codes(uuid, text, text, integer, integer, integer, timestamptz, uuid, text, integer, jsonb, text[]) from public, anon, authenticated;

create or replace function public.platform_generate_codes(
  p_kind text, p_plan text, p_count integer, p_duration_days integer,
  p_max_redemptions integer default 1, p_redeem_by timestamptz default null, p_institution uuid default null,
  p_note text default null, p_grace_days integer default 7, p_limits_override jsonb default '{}'::jsonb,
  p_extra_features text[] default '{}'
)
returns table (id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can generate codes.';
  end if;
  return query select * from public.generate_license_codes(auth.uid(), p_kind, p_plan, p_count, p_duration_days,
    p_max_redemptions, p_redeem_by, p_institution, p_note, p_grace_days, p_limits_override, p_extra_features);
end;
$$;
revoke execute on function public.platform_generate_codes(text, text, integer, integer, integer, timestamptz, uuid, text, integer, jsonb, text[]) from public, anon;
grant execute on function public.platform_generate_codes(text, text, integer, integer, integer, timestamptz, uuid, text, integer, jsonb, text[]) to authenticated;

-- Common checks for redeeming / activating. Locks the code row.
create or replace function public.claim_code(p_code text, p_kinds text[])
returns public.license_codes
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.license_codes;
begin
  if char_length(public.normalize_code(p_code)) not between 10 and 40 then
    raise exception 'That code isn’t valid. Check it and try again.';
  end if;
  select * into c from public.license_codes where code_hash = public.code_hash(p_code) for update;
  if c.id is null then
    raise exception 'That code isn’t valid. Check it and try again.';
  end if;
  if not (c.kind = any (p_kinds)) then
    if c.kind = 'institution' then
      raise exception 'This is an institution licence key. Your principal or director activates it in School → Settings → Licence.';
    end if;
    raise exception 'This is a personal code. Redeem it in Settings → Plan.';
  end if;
  if c.status = 'revoked' then
    raise exception 'This code has been withdrawn.';
  end if;
  if c.redeem_by is not null and c.redeem_by <= now() then
    raise exception 'This code has expired.';
  end if;
  if c.redemption_count >= c.max_redemptions then
    raise exception 'This code has already been used.';
  end if;
  return c;
end;
$$;
revoke execute on function public.claim_code(text, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Individuals: redeem a gift code or individual licence code
-- ---------------------------------------------------------------------
create or replace function public.redeem_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  c public.license_codes;
  rid uuid := gen_random_uuid();
  sid uuid;
  base timestamptz;
  ends timestamptz;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if public.hit_rate_limit(me::text, 'redeem_code', 10, 3600) then
    raise exception 'Too many attempts. Please try again in an hour.';
  end if;
  c := public.claim_code(p_code, array['gift', 'individual']);
  if exists (select 1 from public.code_redemptions where code_id = c.id and user_id = me) then
    raise exception 'You have already redeemed this code.';
  end if;
  -- Codes for the same plan stack: the new period starts when the current one ends.
  select greatest(now(), coalesce(max(s.expires_at), now())) into base
  from public.subscriptions s
  where s.user_id = me and s.plan = c.plan and s.provider = 'gift' and s.status = 'active' and s.expires_at > now();
  ends := base + make_interval(days => c.duration_days);

  insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status, started_at, expires_at)
  values (me, 'gift', rid::text, c.plan, 'active', now(), ends)
  returning id into sid;
  insert into public.code_redemptions (id, code_id, user_id, subscription_id) values (rid, c.id, me, sid);
  update public.license_codes set redemption_count = redemption_count + 1 where id = c.id;
  perform public.write_audit(null, 'redeem', 'license_code', c.id::text, null,
    jsonb_build_object('plan', c.plan, 'expires_at', ends, 'subscription_id', sid), null, jsonb_build_object('kind', c.kind));

  return public.my_entitlements() || jsonb_build_object('redeemed', jsonb_build_object(
    'plan', c.plan, 'plan_name', (select name from public.plans where id = c.plan), 'expires_at', ends));
end;
$$;
revoke execute on function public.redeem_code(text) from public, anon;
grant execute on function public.redeem_code(text) to authenticated;

-- Codes this user has redeemed (shown in Settings).
create or replace function public.my_redemptions()
returns table (redeemed_at timestamptz, kind text, plan_name text, code_hint text, expires_at timestamptz, active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select r.redeemed_at, c.kind, p.name, c.code_hint, s.expires_at, coalesce(public.subscription_is_current(s), false)
  from public.code_redemptions r
  join public.license_codes c on c.id = r.code_id
  join public.plans p on p.id = c.plan
  left join public.subscriptions s on s.id = r.subscription_id
  where r.user_id = auth.uid()
  order by r.redeemed_at desc;
$$;
revoke execute on function public.my_redemptions() from public, anon;
grant execute on function public.my_redemptions() to authenticated;

-- ---------------------------------------------------------------------
-- Institutions: activate and view the licence
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
  -- Renewals start when the current licence ends.
  select greatest(now(), coalesce(max(l.expires_at), now())) into base
  from public.institution_licenses l
  where l.institution_id = p_inst and l.status = 'active' and l.expires_at > now();

  insert into public.institution_licenses (institution_id, code_id, plan, limits_override, extra_features,
                                           starts_at, expires_at, grace_days, activated_by)
  values (p_inst, c.id, c.plan, c.limits_override, c.extra_features, base,
          base + make_interval(days => c.duration_days), c.grace_days, me)
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

-- state: active · grace (expired, features kept for grace_days) · expired · none
create or replace function public.institution_license_status(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cur public.institution_licenses;
  st text;
begin
  if not public.has_inst_perm(p_inst, 'manage_license') then
    raise exception 'Only the principal or director can view the licence.';
  end if;
  select * into cur from public.institution_licenses l
  where l.institution_id = p_inst and l.status = 'active' and l.starts_at <= now()
  order by l.expires_at desc limit 1;
  st := case
    when cur.id is null then 'none'
    when now() < cur.expires_at then 'active'
    when now() < cur.expires_at + make_interval(days => cur.grace_days) then 'grace'
    else 'expired' end;
  return jsonb_build_object(
    'state', st,
    'plan', cur.plan,
    'plan_name', (select name from public.plans where id = cur.plan),
    'expires_at', (select max(l.expires_at) from public.institution_licenses l where l.institution_id = p_inst and l.status = 'active'),
    'grace_ends_at', cur.expires_at + make_interval(days => cur.grace_days),
    'features', (select to_jsonb(p.features || cur.extra_features) from public.plans p where p.id = cur.plan),
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

-- ---------------------------------------------------------------------
-- Platform owner: codes, licences, plans, manual grants
-- ---------------------------------------------------------------------
create or replace function public.platform_codes(p_kind text default null)
returns table (
  id uuid, kind text, code_hint text, plan text, plan_name text, duration_days integer, max_redemptions integer,
  redemption_count integer, redeem_by timestamptz, institution_id uuid, institution_name text, note text,
  status text, revoked_reason text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can view codes.';
  end if;
  return query
  select c.id, c.kind, c.code_hint, c.plan, p.name, c.duration_days, c.max_redemptions, c.redemption_count, c.redeem_by,
         c.institution_id, i.name, c.note, c.status, c.revoked_reason, c.created_at
  from public.license_codes c
  join public.plans p on p.id = c.plan
  left join public.institutions i on i.id = c.institution_id
  where p_kind is null or c.kind = p_kind
  order by c.created_at desc
  limit 1000;
end;
$$;
revoke execute on function public.platform_codes(text) from public, anon;
grant execute on function public.platform_codes(text) to authenticated;

-- Who redeemed a code: usernames for personal codes, institution for licences.
create or replace function public.platform_code_redemptions(p_code uuid)
returns table (redeemed_at timestamptz, who text, institution_name text, expires_at timestamptz, active boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can view redemptions.';
  end if;
  return query
  select r.redeemed_at,
         coalesce(pr.username, '(deleted account)'),
         i.name,
         coalesce(s.expires_at, l.expires_at),
         coalesce(public.subscription_is_current(s), l.status = 'active' and l.expires_at > now(), false)
  from public.code_redemptions r
  left join public.profiles pr on pr.id = r.user_id
  left join public.institutions i on i.id = r.institution_id
  left join public.subscriptions s on s.id = r.subscription_id
  left join public.institution_licenses l on l.id = r.license_id
  where r.code_id = p_code
  order by r.redeemed_at desc;
end;
$$;
revoke execute on function public.platform_code_redemptions(uuid) from public, anon;
grant execute on function public.platform_code_redemptions(uuid) to authenticated;

-- Revoking stops new redemptions. With p_end_access, access already granted
-- by the code ends now too (gift subscriptions expire, licences are revoked).
create or replace function public.platform_revoke_code(p_code uuid, p_reason text, p_end_access boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.license_codes;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can revoke codes.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for revoking.';
  end if;
  update public.license_codes set status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason)
  where id = p_code and status = 'active' returning * into c;
  if c.id is null then
    raise exception 'Code not found or already revoked.';
  end if;
  if p_end_access then
    update public.subscriptions s set status = 'expired', expires_at = least(coalesce(s.expires_at, now()), now())
    where s.id in (select r.subscription_id from public.code_redemptions r where r.code_id = c.id) and public.subscription_is_current(s);
    update public.institution_licenses set status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason)
    where code_id = c.id and status = 'active';
  end if;
  perform public.write_audit(c.institution_id, 'revoke', 'license_code', c.id::text, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'revoked', 'end_access', p_end_access), p_reason);
end;
$$;
revoke execute on function public.platform_revoke_code(uuid, text, boolean) from public, anon;
grant execute on function public.platform_revoke_code(uuid, text, boolean) to authenticated;

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
              when now() < l.expires_at then 'active'
              when now() < l.expires_at + make_interval(days => l.grace_days) then 'grace'
              else 'expired' end,
         l.activated_at, l.revoked_reason, c.code_hint
  from public.institution_licenses l
  join public.institutions i on i.id = l.institution_id
  join public.plans p on p.id = l.plan
  left join public.license_codes c on c.id = l.code_id
  order by l.activated_at desc;
end;
$$;
revoke execute on function public.platform_licenses() from public, anon;
grant execute on function public.platform_licenses() to authenticated;

create or replace function public.platform_revoke_license(p_license uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.institution_licenses;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can revoke licences.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for revoking.';
  end if;
  update public.institution_licenses set status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason)
  where id = p_license and status = 'active' returning * into l;
  if l.id is null then
    raise exception 'Licence not found or already revoked.';
  end if;
  perform public.write_audit(l.institution_id, 'revoke', 'institution_license', l.id::text,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'revoked'), p_reason);
end;
$$;
revoke execute on function public.platform_revoke_license(uuid, text) from public, anon;
grant execute on function public.platform_revoke_license(uuid, text) to authenticated;

-- Limits and features per plan (prices stay with the payment provider setup).
create or replace function public.platform_update_plan(p_plan text, p_limits jsonb, p_features text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.plans;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can change plans.';
  end if;
  select * into old from public.plans where id = p_plan for update;
  if old.id is null then
    raise exception 'Plan not found.';
  end if;
  perform public.check_limits_override(p_limits);
  perform public.check_feature_keys(p_features);
  if p_plan = 'free' and exists (select 1 from jsonb_each(p_limits) e where e.value = 'null'::jsonb) then
    raise exception 'The Free plan needs a number for every limit.';
  end if;
  update public.plans set limits = p_limits, features = array(select distinct f from unnest(p_features) f order by f), updated_at = now()
  where id = p_plan;
  perform public.write_audit(null, 'update', 'plan', p_plan,
    jsonb_build_object('limits', old.limits, 'features', old.features),
    jsonb_build_object('limits', p_limits, 'features', p_features));
end;
$$;
revoke execute on function public.platform_update_plan(text, jsonb, text[]) from public, anon;
grant execute on function public.platform_update_plan(text, jsonb, text[]) to authenticated;

-- Look up one personal account by username: plan sources and subscriptions.
create or replace function public.platform_user_plan(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can look up accounts.';
  end if;
  select id into uid from public.profiles where username = lower(btrim(p_username));
  if uid is null then
    raise exception 'No user with that username.';
  end if;
  return jsonb_build_object(
    'user_id', uid,
    'username', lower(btrim(p_username)),
    'plan', public.plan_of(uid),
    'limits', public.effective_limits(uid),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'provider', s.provider, 'plan', s.plan, 'status', s.status, 'started_at', s.started_at,
        'expires_at', s.expires_at, 'current', public.subscription_is_current(s)) order by s.created_at desc)
      from public.subscriptions s where s.user_id = uid), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.platform_user_plan(text) from public, anon;
grant execute on function public.platform_user_plan(text) to authenticated;

create or replace function public.platform_grant_plan(p_username text, p_plan text, p_days integer, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  sid uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can grant plans.';
  end if;
  select id into uid from public.profiles where username = lower(btrim(p_username));
  if uid is null then
    raise exception 'No user with that username.';
  end if;
  if not exists (select 1 from public.plans where id = p_plan and id <> 'free') then
    raise exception 'Choose a paid plan.';
  end if;
  if p_days is null or p_days not between 1 and 3660 then
    raise exception 'Duration must be 1 to 3660 days.';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Add a note saying why.';
  end if;
  insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status, started_at, expires_at)
  values (uid, 'manual', gen_random_uuid()::text, p_plan, 'active', now(), now() + make_interval(days => p_days))
  returning id into sid;
  perform public.write_audit(null, 'grant', 'subscription', sid::text, null,
    jsonb_build_object('user_id', uid, 'plan', p_plan, 'days', p_days), p_note);
  return sid;
end;
$$;
revoke execute on function public.platform_grant_plan(text, text, integer, text) from public, anon;
grant execute on function public.platform_grant_plan(text, text, integer, text) to authenticated;

-- Ends a manual grant or gift subscription now (paid ones are cancelled with the provider).
create or replace function public.platform_end_subscription(p_subscription uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.subscriptions;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can end subscriptions.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason.';
  end if;
  update public.subscriptions set status = 'expired', expires_at = now()
  where id = p_subscription and provider in ('manual', 'gift') and status = 'active' returning * into s;
  if s.id is null then
    raise exception 'Only active manual grants and gift subscriptions can be ended here.';
  end if;
  perform public.write_audit(null, 'end', 'subscription', s.id::text, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'expired'), p_reason, jsonb_build_object('user_id', s.user_id, 'provider', s.provider));
end;
$$;
revoke execute on function public.platform_end_subscription(uuid, text) from public, anon;
grant execute on function public.platform_end_subscription(uuid, text) to authenticated;

create or replace function public.platform_license_audit()
returns table (created_at timestamptz, action text, record_type text, record_id text, institution_name text,
               new_value jsonb, reason text, actor text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can view this history.';
  end if;
  return query
  select a.created_at, a.action, a.record_type, a.record_id, i.name, a.new_value, a.reason,
         coalesce(pr.username, case when a.actor_id is null then 'script' else '—' end)
  from public.audit_log a
  left join public.institutions i on i.id = a.institution_id
  left join public.profiles pr on pr.id = a.actor_id
  where a.record_type in ('license_code', 'institution_license', 'plan', 'subscription')
  order by a.created_at desc
  limit 300;
end;
$$;
revoke execute on function public.platform_license_audit() from public, anon;
grant execute on function public.platform_license_audit() to authenticated;
