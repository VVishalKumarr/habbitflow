-- =====================================================================
-- Phase 5: per-student AI quotas and cost controls.
--
-- * Every AI request goes through ai_begin() (server only) before the model
--   is called and ai_finish() afterwards. ai_begin checks the feature, the
--   request size, the student's allowance for the current period, an hourly
--   burst limit, the optional institution credit pool and monthly token caps,
--   and reserves one unit — all under a per-user advisory lock, so
--   simultaneous requests can't exceed a limit.
-- * Counting: successful requests count. Requests refused by a limit or
--   validation are recorded as 'rejected' and don't count. Provider/server
--   errors are 'refunded' and don't count. A retry with the same request id
--   is never charged twice. A reservation that never finishes stops counting
--   after 10 minutes.
-- * Allowances: the personal plan (Free/Plus/Pro, from subscriptions and gift
--   codes) and, for members of a licensed institution, the institution's
--   allowance (platform 'institution' limits, optionally lowered by the
--   institution). The more generous applies; requests are charged to the
--   personal allowance first, then to the institution (and its pool).
-- * Periods (day / week / month) follow ai_settings.quota_timezone.
-- Additive. Safe to re-run: edited quotas and settings are not overwritten.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------
create table if not exists public.ai_settings (
  id                   boolean primary key default true check (id),
  quota_timezone       text not null default 'Asia/Kolkata' check (char_length(quota_timezone) between 1 and 64),
  max_input_chars      integer not null default 4000 check (max_input_chars between 100 and 50000),
  max_output_tokens    integer not null default 2000 check (max_output_tokens between 100 and 16000),
  hourly_burst         integer not null default 30 check (hourly_burst between 1 and 1000),
  monthly_token_cap    bigint check (monthly_token_cap is null or monthly_token_cap > 0),
  usd_per_mtok_input   numeric(10, 4) not null default 5 check (usd_per_mtok_input >= 0),
  usd_per_mtok_output  numeric(10, 4) not null default 25 check (usd_per_mtok_output >= 0),
  updated_at           timestamptz not null default now()
);
insert into public.ai_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.ai_features (
  feature  text primary key check (feature ~ '^[a-z_]{2,40}$'),
  label    text not null check (char_length(label) between 1 and 80),
  period   text not null check (period in ('day', 'week', 'month')),
  enabled  boolean not null default true,
  sort     smallint not null default 0
);
insert into public.ai_features (feature, label, period, sort) values
  ('chat', 'AI help assistant (text)', 'day', 1),
  ('voice_command', 'AI voice commands', 'day', 2),
  ('timetable_generate', 'AI timetable generation', 'month', 3),
  ('timetable_evaluate', 'Timetable evaluation and optimisation', 'month', 4),
  ('study_plan', 'Homework and study planning', 'month', 5),
  ('reschedule', 'AI rescheduling', 'month', 6)
on conflict (feature) do nothing;

-- plan_key: a plans.id or 'institution'. max_requests null = unlimited.
create table if not exists public.ai_plan_quotas (
  plan_key     text not null check (plan_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  feature      text not null references public.ai_features (feature) on delete cascade,
  enabled      boolean not null default true,
  max_requests integer check (max_requests is null or max_requests between 0 and 100000),
  updated_at   timestamptz not null default now(),
  primary key (plan_key, feature)
);
-- Initial defaults (change them in Platform admin → AI).
insert into public.ai_plan_quotas (plan_key, feature, enabled, max_requests) values
  ('free', 'chat', true, 10),          ('plus', 'chat', true, 40),          ('pro', 'chat', true, 100),          ('institution', 'chat', true, 50),
  ('free', 'voice_command', true, 10), ('plus', 'voice_command', true, 50), ('pro', 'voice_command', true, 150), ('institution', 'voice_command', true, 50),
  ('free', 'timetable_generate', false, 0), ('plus', 'timetable_generate', true, 10), ('pro', 'timetable_generate', true, 40), ('institution', 'timetable_generate', true, 20),
  ('free', 'timetable_evaluate', true, 3),  ('plus', 'timetable_evaluate', true, 20), ('pro', 'timetable_evaluate', true, 60), ('institution', 'timetable_evaluate', true, 30),
  ('free', 'study_plan', false, 0),    ('plus', 'study_plan', true, 10),    ('pro', 'study_plan', true, 40),    ('institution', 'study_plan', true, 20),
  ('free', 'reschedule', true, 5),     ('plus', 'reschedule', true, 30),    ('pro', 'reschedule', true, 100),   ('institution', 'reschedule', true, 40)
on conflict (plan_key, feature) do nothing;

-- Institution's own settings (never above the platform 'institution' limits).
create table if not exists public.institution_ai_quotas (
  institution_id uuid not null references public.institutions (id) on delete cascade,
  feature        text not null references public.ai_features (feature) on delete cascade,
  enabled        boolean not null default true,
  max_requests   integer check (max_requests is null or max_requests between 0 and 100000),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (institution_id, feature)
);

-- Optional shared pool per institution (set by the platform owner, e.g. as
-- part of a contract). Applies to requests charged to the institution.
create table if not exists public.institution_ai_pools (
  institution_id    uuid primary key references public.institutions (id) on delete cascade,
  enabled           boolean not null default false,
  monthly_requests  integer check (monthly_requests is null or monthly_requests between 0 and 10000000),
  monthly_token_cap bigint check (monthly_token_cap is null or monthly_token_cap > 0),
  updated_at        timestamptz not null default now()
);

create table if not exists public.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  institution_id uuid references public.institutions (id) on delete set null,
  feature        text not null references public.ai_features (feature),
  plan_key       text not null,
  charged_to     text check (charged_to in ('personal', 'institution')),
  period_start   timestamptz not null,
  request_id     text check (request_id is null or request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  status         text not null check (status in ('reserved', 'succeeded', 'refunded', 'rejected')),
  reason         text check (reason is null or char_length(reason) <= 200),
  units          integer not null default 1 check (units between 0 and 1000),
  input_chars    integer,
  tokens_in      integer check (tokens_in is null or tokens_in >= 0),
  tokens_out     integer check (tokens_out is null or tokens_out >= 0),
  audio_seconds  numeric(10, 2) check (audio_seconds is null or audio_seconds >= 0),
  model          text check (model is null or char_length(model) <= 80),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create unique index if not exists ai_usage_request_idx on public.ai_usage (user_id, request_id) where request_id is not null and status <> 'rejected';
create index if not exists ai_usage_count_idx on public.ai_usage (user_id, feature, period_start);
create index if not exists ai_usage_inst_idx on public.ai_usage (institution_id, created_at) where institution_id is not null;
create index if not exists ai_usage_month_idx on public.ai_usage (created_at);

alter table public.ai_settings enable row level security;
alter table public.ai_features enable row level security;
alter table public.ai_plan_quotas enable row level security;
alter table public.institution_ai_quotas enable row level security;
alter table public.institution_ai_pools enable row level security;
alter table public.ai_usage enable row level security;
revoke all on public.ai_settings, public.ai_features, public.ai_plan_quotas, public.institution_ai_quotas,
              public.institution_ai_pools, public.ai_usage from anon, authenticated;
-- Feature list and plan quotas are public information (shown on plan pages).
drop policy if exists "read" on public.ai_features;
create policy "read" on public.ai_features for select to anon, authenticated using (true);
drop policy if exists "read" on public.ai_plan_quotas;
create policy "read" on public.ai_plan_quotas for select to anon, authenticated using (true);
grant select on public.ai_features, public.ai_plan_quotas to anon, authenticated;
-- Students read their own usage history; nobody can edit it.
drop policy if exists "own" on public.ai_usage;
create policy "own" on public.ai_usage for select to authenticated using (user_id = (select auth.uid()));
grant select (id, feature, plan_key, charged_to, period_start, status, reason, units, tokens_in, tokens_out, created_at, finished_at)
  on public.ai_usage to authenticated;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.ai_period_start(p_period text, p_at timestamptz default now())
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc(p_period, p_at at time zone s.quota_timezone) at time zone s.quota_timezone
  from public.ai_settings s;
$$;

create or replace function public.ai_period_end(p_period text, p_start timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_start at time zone s.quota_timezone) + ('1 ' || p_period)::interval) at time zone s.quota_timezone
  from public.ai_settings s;
$$;

-- null = unlimited
create or replace function public.ai_least(a integer, b integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when a is null then b when b is null then a else least(a, b) end;
$$;

-- The allowances that apply to a user for a feature right now.
create or replace function public.ai_allowance(p_user uuid, p_feature text)
returns table (
  plan_key text, personal_enabled boolean, personal_limit integer,
  institution_id uuid, institution_name text, institution_enabled boolean, institution_limit integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with personal as (
    select coalesce((select es.plan_id from public.entitlement_sources(p_user) es
                     where es.source = 'subscription' order by es.rank desc limit 1), 'free') as k
  ),
  inst as (
    select es.institution_id, es.institution_name from public.entitlement_sources(p_user) es
    where es.source = 'institution' order by es.rank desc limit 1
  )
  select personal.k,
         coalesce(pq.enabled, false), case when coalesce(pq.enabled, false) then pq.max_requests else 0 end,
         inst.institution_id, inst.institution_name,
         inst.institution_id is not null and coalesce(iq.enabled, false) and coalesce(io.enabled, true),
         case when inst.institution_id is not null and coalesce(iq.enabled, false) and coalesce(io.enabled, true)
              then public.ai_least(iq.max_requests, io.max_requests) else 0 end
  from personal
  left join inst on true
  left join public.ai_plan_quotas pq on pq.plan_key = personal.k and pq.feature = p_feature
  left join public.ai_plan_quotas iq on iq.plan_key = 'institution' and iq.feature = p_feature
  left join public.institution_ai_quotas io on io.institution_id = inst.institution_id and io.feature = p_feature;
$$;
revoke execute on function public.ai_allowance(uuid, text) from public, anon, authenticated;

-- Units that count towards a period: successes, and reservations still in flight.
create or replace function public.ai_used(p_user uuid, p_feature text, p_period_start timestamptz)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(units), 0)::integer from public.ai_usage
  where user_id = p_user and feature = p_feature and period_start = p_period_start
    and (status = 'succeeded' or (status = 'reserved' and created_at > now() - interval '10 minutes'));
$$;
revoke execute on function public.ai_used(uuid, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- ai_begin / ai_finish (Edge Functions only)
-- ---------------------------------------------------------------------
create or replace function public.ai_begin(p_user uuid, p_feature text, p_request_id text default null, p_input_chars integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.ai_features;
  st public.ai_settings;
  a record;
  ps timestamptz;
  pe timestamptz;
  used integer;
  allow integer;
  charge text;
  pool public.institution_ai_pools;
  existing public.ai_usage;
  uid uuid;
  rid text := nullif(btrim(coalesce(p_request_id, '')), '');

  -- records a refusal (not counted) and returns the structured response
  function_result jsonb;
begin
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated', 'error', 'Please log in again.');
  end if;
  select * into f from public.ai_features where feature = p_feature;
  if f.feature is null then
    return jsonb_build_object('ok', false, 'code', 'unknown_feature', 'error', 'Unknown AI feature.');
  end if;
  select * into st from public.ai_settings;
  ps := public.ai_period_start(f.period);
  pe := public.ai_period_end(f.period, ps);

  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_user::text, 0));

  -- Retries: never charge the same request twice.
  if rid is not null then
    select * into existing from public.ai_usage where user_id = p_user and request_id = rid and status <> 'rejected';
    if existing.status = 'succeeded' then
      return jsonb_build_object('ok', false, 'code', 'duplicate', 'error', 'This request was already completed.', 'usage_id', existing.id);
    elsif existing.status = 'reserved' and existing.created_at > now() - interval '10 minutes' then
      return jsonb_build_object('ok', false, 'code', 'in_progress', 'error', 'This request is still being processed.');
    end if;
  end if;

  select * into a from public.ai_allowance(p_user, p_feature);
  allow := case
    when not f.enabled then 0
    when a.personal_limit is null or a.institution_limit is null then null
    else greatest(a.personal_limit, a.institution_limit) end;
  used := public.ai_used(p_user, p_feature, ps);

  function_result := case
    when not f.enabled or (not a.personal_enabled and not a.institution_enabled) then
      jsonb_build_object('code', 'feature_disabled',
        'error', case when a.institution_id is not null then 'This AI feature isn’t available for your account. Ask your school if it can be switched on.'
                      else 'This AI feature isn’t included in your plan.' end)
    when coalesce(p_input_chars, 0) > st.max_input_chars then
      jsonb_build_object('code', 'too_large', 'error', 'That request is too long. Please shorten it to ' || st.max_input_chars || ' characters.')
    when allow is not null and used >= allow then
      jsonb_build_object('code', 'quota_exceeded',
        'error', 'You’ve used all ' || allow || ' ' || lower(f.label) || ' requests for this ' || f.period || '.')
    when (select count(*) from public.ai_usage u where u.user_id = p_user and u.created_at > now() - interval '1 hour'
            and (u.status = 'succeeded' or (u.status = 'reserved' and u.created_at > now() - interval '10 minutes'))) >= st.hourly_burst then
      jsonb_build_object('code', 'rate_limited', 'error', 'You’ve made a lot of AI requests in the last hour. Please try again a little later.',
        'resets_at', now() + interval '1 hour')
    when st.monthly_token_cap is not null and (select coalesce(sum(coalesce(u.tokens_in, 0) + coalesce(u.tokens_out, 0)), 0) from public.ai_usage u
            where u.created_at >= date_trunc('month', now()) and u.status = 'succeeded') >= st.monthly_token_cap then
      jsonb_build_object('code', 'spend_cap', 'error', 'AI features are paused for the rest of the month. Please try again later.',
        'resets_at', date_trunc('month', now()) + interval '1 month')
    else null end;

  if function_result is null then
    -- Charge the personal allowance first, then the institution.
    charge := case when a.personal_enabled and (a.personal_limit is null or used < a.personal_limit) then 'personal' else 'institution' end;
    if charge = 'institution' then
      perform pg_advisory_xact_lock(hashtextextended('ai-pool:' || a.institution_id::text, 0));
      select * into pool from public.institution_ai_pools where institution_id = a.institution_id;
      if pool.enabled and pool.monthly_requests is not null and (
           select coalesce(sum(u.units), 0) from public.ai_usage u
           where u.institution_id = a.institution_id and u.charged_to = 'institution' and u.created_at >= date_trunc('month', now())
             and (u.status = 'succeeded' or (u.status = 'reserved' and u.created_at > now() - interval '10 minutes'))) >= pool.monthly_requests then
        function_result := jsonb_build_object('code', 'pool_exhausted',
          'error', 'Your school’s shared AI credits for this month are used up. Ask your school administrator.',
          'resets_at', date_trunc('month', now()) + interval '1 month');
      elsif pool.enabled and pool.monthly_token_cap is not null and (
           select coalesce(sum(coalesce(u.tokens_in, 0) + coalesce(u.tokens_out, 0)), 0) from public.ai_usage u
           where u.institution_id = a.institution_id and u.charged_to = 'institution' and u.created_at >= date_trunc('month', now())
             and u.status = 'succeeded') >= pool.monthly_token_cap then
        function_result := jsonb_build_object('code', 'pool_exhausted',
          'error', 'Your school’s AI budget for this month is used up. Ask your school administrator.',
          'resets_at', date_trunc('month', now()) + interval '1 month');
      end if;
    end if;
  end if;

  if function_result is not null then
    insert into public.ai_usage (user_id, institution_id, feature, plan_key, period_start, status, reason, units, input_chars, finished_at)
    values (p_user, a.institution_id, p_feature, a.plan_key, ps, 'rejected', function_result ->> 'code', 0, p_input_chars, now());
    return function_result || jsonb_build_object(
      'ok', false, 'feature', p_feature, 'limit', allow, 'used', used, 'period', f.period,
      'resets_at', coalesce(function_result ->> 'resets_at', pe::text),
      'plan', a.plan_key, 'institution', a.institution_name is not null);
  end if;

  if existing.id is not null then
    -- retry of a refunded/abandoned request: reuse its row
    update public.ai_usage set status = 'reserved', reason = null, created_at = now(), finished_at = null, period_start = ps,
                               charged_to = charge, plan_key = a.plan_key, institution_id = case when charge = 'institution' then a.institution_id end
    where id = existing.id returning id into uid;
  else
    insert into public.ai_usage (user_id, institution_id, feature, plan_key, charged_to, period_start, request_id, status, input_chars)
    values (p_user, case when charge = 'institution' then a.institution_id end, p_feature, a.plan_key, charge, ps, rid, 'reserved', p_input_chars)
    returning id into uid;
  end if;
  return jsonb_build_object('ok', true, 'usage_id', uid, 'feature', p_feature, 'charged_to', charge,
    'limit', allow, 'used', used + 1, 'remaining', case when allow is null then null else allow - used - 1 end,
    'period', f.period, 'resets_at', pe, 'max_output_tokens', st.max_output_tokens);
end;
$$;
revoke execute on function public.ai_begin(uuid, text, text, integer) from public, anon, authenticated;

-- p_ok false = the request failed on our side or the provider's: refunded.
create or replace function public.ai_finish(
  p_usage uuid, p_ok boolean, p_tokens_in integer default null, p_tokens_out integer default null,
  p_audio_seconds numeric default null, p_model text default null, p_error text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ai_usage
  set status = case when p_ok then 'succeeded' else 'refunded' end,
      tokens_in = p_tokens_in, tokens_out = p_tokens_out, audio_seconds = p_audio_seconds,
      model = left(p_model, 80), reason = left(p_error, 200), finished_at = now()
  where id = p_usage and status = 'reserved';
$$;
revoke execute on function public.ai_finish(uuid, boolean, integer, integer, numeric, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Students: my quotas
-- ---------------------------------------------------------------------
create or replace function public.my_ai_usage()
returns table (
  feature text, label text, period text, enabled boolean, "limit" integer, used integer, remaining integer,
  resets_at timestamptz, plan_key text, institution_name text, upgrade_available boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  return query
  select f.feature, f.label, f.period,
         f.enabled and (a.personal_enabled or a.institution_enabled),
         case when not f.enabled then 0
              when a.personal_limit is null or a.institution_limit is null then null
              else greatest(a.personal_limit, a.institution_limit) end,
         public.ai_used(me, f.feature, public.ai_period_start(f.period)),
         case when not f.enabled then 0
              when a.personal_limit is null or a.institution_limit is null then null
              else greatest(0, greatest(a.personal_limit, a.institution_limit) - public.ai_used(me, f.feature, public.ai_period_start(f.period))) end,
         public.ai_period_end(f.period, public.ai_period_start(f.period)),
         a.plan_key, a.institution_name,
         exists (select 1 from public.ai_plan_quotas q join public.plans p on p.id = q.plan_key
                 join public.plans mine on mine.id = a.plan_key
                 where q.feature = f.feature and q.enabled and p.rank > mine.rank
                   and (q.max_requests is null or a.personal_limit is not null and q.max_requests > a.personal_limit))
  from public.ai_features f
  cross join lateral public.ai_allowance(me, f.feature) a
  order by f.sort;
end;
$$;
revoke execute on function public.my_ai_usage() from public, anon;
grant execute on function public.my_ai_usage() to authenticated;

-- ---------------------------------------------------------------------
-- Institutions: settings and usage (principal/director)
-- ---------------------------------------------------------------------
create or replace function public.institution_ai_overview(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pool public.institution_ai_pools;
begin
  if not public.has_inst_perm(p_inst, 'manage_institution_settings') then
    raise exception 'Only the principal or director can manage AI settings.';
  end if;
  select * into pool from public.institution_ai_pools where institution_id = p_inst;
  return jsonb_build_object(
    'features', coalesce((select jsonb_agg(jsonb_build_object(
        'feature', f.feature, 'label', f.label, 'period', f.period,
        'platform_enabled', f.enabled and coalesce(q.enabled, false),
        'platform_max', q.max_requests,
        'enabled', coalesce(io.enabled, true), 'max_requests', io.max_requests,
        'used_this_period', (select coalesce(sum(u.units), 0) from public.ai_usage u
                             join public.institution_memberships m on m.user_id = u.user_id and m.institution_id = p_inst
                             where u.feature = f.feature and u.status = 'succeeded' and u.period_start = public.ai_period_start(f.period)),
        'students_using', (select count(distinct u.user_id) from public.ai_usage u
                           join public.institution_memberships m on m.user_id = u.user_id and m.institution_id = p_inst and m.role = 'student'
                           where u.feature = f.feature and u.status = 'succeeded' and u.period_start = public.ai_period_start(f.period)))
        order by f.sort)
      from public.ai_features f
      left join public.ai_plan_quotas q on q.plan_key = 'institution' and q.feature = f.feature
      left join public.institution_ai_quotas io on io.institution_id = p_inst and io.feature = f.feature), '[]'::jsonb),
    'pool', case when pool.enabled then jsonb_build_object(
        'monthly_requests', pool.monthly_requests,
        'used_requests', (select coalesce(sum(u.units), 0) from public.ai_usage u where u.institution_id = p_inst and u.charged_to = 'institution'
                          and u.status = 'succeeded' and u.created_at >= date_trunc('month', now())),
        'monthly_token_cap', pool.monthly_token_cap,
        'used_tokens', (select coalesce(sum(coalesce(u.tokens_in, 0) + coalesce(u.tokens_out, 0)), 0) from public.ai_usage u
                        where u.institution_id = p_inst and u.charged_to = 'institution' and u.status = 'succeeded'
                          and u.created_at >= date_trunc('month', now())),
        'resets_at', date_trunc('month', now()) + interval '1 month') end,
    -- Counts only: no prompts or answers are stored anywhere.
    'students', coalesce((select jsonb_agg(x order by x.total desc) from (
        select m.display_name as name, m.id as membership_id, count(*)::integer as total,
               (select jsonb_object_agg(k.feature, k.n) from (
                  select u2.feature, count(*)::integer n from public.ai_usage u2
                  where u2.user_id = m.user_id and u2.status = 'succeeded' and u2.created_at >= date_trunc('month', now())
                  group by u2.feature) k) as by_feature
        from public.institution_memberships m
        join public.ai_usage u on u.user_id = m.user_id and u.status = 'succeeded' and u.created_at >= date_trunc('month', now())
        where m.institution_id = p_inst and m.role = 'student'
        group by m.id, m.display_name, m.user_id
        limit 200) x), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.institution_ai_overview(uuid) from public, anon;
grant execute on function public.institution_ai_overview(uuid) to authenticated;

create or replace function public.institution_set_ai_quota(p_inst uuid, p_feature text, p_enabled boolean, p_max_requests integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.ai_plan_quotas;
  old public.institution_ai_quotas;
begin
  if not public.has_inst_perm(p_inst, 'manage_institution_settings') then
    raise exception 'Only the principal or director can manage AI settings.';
  end if;
  select * into q from public.ai_plan_quotas where plan_key = 'institution' and feature = p_feature;
  if q.feature is null then
    raise exception 'Unknown AI feature.';
  end if;
  if p_max_requests is not null and (p_max_requests < 0 or (q.max_requests is not null and p_max_requests > q.max_requests)) then
    raise exception 'The limit can be 0 to % for this feature.', coalesce(q.max_requests::text, 'unlimited');
  end if;
  select * into old from public.institution_ai_quotas where institution_id = p_inst and feature = p_feature;
  insert into public.institution_ai_quotas (institution_id, feature, enabled, max_requests, updated_by, updated_at)
  values (p_inst, p_feature, p_enabled, p_max_requests, auth.uid(), now())
  on conflict (institution_id, feature) do update
    set enabled = excluded.enabled, max_requests = excluded.max_requests, updated_by = excluded.updated_by, updated_at = now();
  perform public.write_audit(p_inst, 'update', 'ai_quota', p_feature,
    case when old.feature is not null then jsonb_build_object('enabled', old.enabled, 'max_requests', old.max_requests) end,
    jsonb_build_object('enabled', p_enabled, 'max_requests', p_max_requests));
end;
$$;
revoke execute on function public.institution_set_ai_quota(uuid, text, boolean, integer) from public, anon;
grant execute on function public.institution_set_ai_quota(uuid, text, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------
-- Platform owner
-- ---------------------------------------------------------------------
create or replace function public.platform_ai_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  st public.ai_settings;
  m0 timestamptz := date_trunc('month', now());
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can view AI settings.';
  end if;
  select * into st from public.ai_settings;
  return jsonb_build_object(
    'settings', to_jsonb(st) - 'id',
    'features', (select jsonb_agg(to_jsonb(f) order by f.sort) from public.ai_features f),
    'quotas', (select jsonb_agg(jsonb_build_object('plan_key', q.plan_key, 'feature', q.feature, 'enabled', q.enabled, 'max_requests', q.max_requests))
               from public.ai_plan_quotas q),
    'plans', (select jsonb_agg(jsonb_build_object('key', p.id, 'name', p.name) order by p.rank) from public.plans p)
             || jsonb_build_array(jsonb_build_object('key', 'institution', 'name', 'Institution')),
    'month', jsonb_build_object(
      'requests', (select count(*) from public.ai_usage where created_at >= m0 and status = 'succeeded'),
      'refused', (select count(*) from public.ai_usage where created_at >= m0 and status = 'rejected'),
      'refunded', (select count(*) from public.ai_usage where created_at >= m0 and status = 'refunded'),
      'tokens_in', (select coalesce(sum(tokens_in), 0) from public.ai_usage where created_at >= m0 and status = 'succeeded'),
      'tokens_out', (select coalesce(sum(tokens_out), 0) from public.ai_usage where created_at >= m0 and status = 'succeeded'),
      'by_feature', coalesce((select jsonb_object_agg(feature, n) from (select feature, count(*) n from public.ai_usage
                     where created_at >= m0 and status = 'succeeded' group by feature) x), '{}'::jsonb),
      'by_plan', coalesce((select jsonb_object_agg(k, n) from (select case when charged_to = 'institution' then 'institution' else plan_key end k, count(*) n
                  from public.ai_usage where created_at >= m0 and status = 'succeeded' group by 1) x), '{}'::jsonb),
      'by_refusal', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from public.ai_usage
                     where created_at >= m0 and status = 'rejected' group by reason) x), '{}'::jsonb)),
    'institutions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name,
        'requests', (select count(*) from public.ai_usage u join public.institution_memberships m on m.user_id = u.user_id and m.institution_id = i.id
                     where u.created_at >= m0 and u.status = 'succeeded'),
        'tokens', (select coalesce(sum(coalesce(u.tokens_in, 0) + coalesce(u.tokens_out, 0)), 0) from public.ai_usage u
                   where u.institution_id = i.id and u.created_at >= m0 and u.status = 'succeeded'),
        'pool', (select to_jsonb(p) - 'institution_id' from public.institution_ai_pools p where p.institution_id = i.id)) order by i.name)
      from public.institutions i where i.status = 'active'), '[]'::jsonb),
    -- Personal accounts by username; institution members are shown only as a count per institution above.
    'top_users', coalesce((select jsonb_agg(x) from (
        select pr.username, count(*)::integer as requests from public.ai_usage u
        join public.profiles pr on pr.id = u.user_id
        where u.created_at >= m0 and u.status = 'succeeded'
          and not exists (select 1 from public.institution_memberships m where m.user_id = u.user_id)
        group by pr.username order by count(*) desc limit 20) x), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.platform_ai_overview() from public, anon;
grant execute on function public.platform_ai_overview() to authenticated;

create or replace function public.platform_set_ai_feature(p_feature text, p_enabled boolean, p_period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.ai_features;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can change AI settings.';
  end if;
  if p_period not in ('day', 'week', 'month') then
    raise exception 'Choose day, week or month.';
  end if;
  update public.ai_features set enabled = p_enabled, period = p_period where feature = p_feature returning * into old;
  if old.feature is null then
    raise exception 'Unknown AI feature.';
  end if;
  perform public.write_audit(null, 'update', 'ai_feature', p_feature, null, jsonb_build_object('enabled', p_enabled, 'period', p_period));
end;
$$;
revoke execute on function public.platform_set_ai_feature(text, boolean, text) from public, anon;
grant execute on function public.platform_set_ai_feature(text, boolean, text) to authenticated;

create or replace function public.platform_set_ai_quota(p_plan_key text, p_feature text, p_enabled boolean, p_max_requests integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can change AI quotas.';
  end if;
  if p_plan_key <> 'institution' and not exists (select 1 from public.plans where id = p_plan_key) then
    raise exception 'Unknown plan.';
  end if;
  if not exists (select 1 from public.ai_features where feature = p_feature) then
    raise exception 'Unknown AI feature.';
  end if;
  if p_max_requests is not null and p_max_requests not between 0 and 100000 then
    raise exception 'The limit must be 0 to 100000, or empty for unlimited.';
  end if;
  insert into public.ai_plan_quotas (plan_key, feature, enabled, max_requests, updated_at)
  values (p_plan_key, p_feature, p_enabled, p_max_requests, now())
  on conflict (plan_key, feature) do update set enabled = excluded.enabled, max_requests = excluded.max_requests, updated_at = now();
  perform public.write_audit(null, 'update', 'ai_quota', p_plan_key || ':' || p_feature, null,
    jsonb_build_object('enabled', p_enabled, 'max_requests', p_max_requests));
end;
$$;
revoke execute on function public.platform_set_ai_quota(text, text, boolean, integer) from public, anon;
grant execute on function public.platform_set_ai_quota(text, text, boolean, integer) to authenticated;

create or replace function public.platform_update_ai_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.ai_settings;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can change AI settings.';
  end if;
  select * into old from public.ai_settings for update;
  if p ? 'quota_timezone' and not exists (select 1 from pg_timezone_names where name = p ->> 'quota_timezone') then
    raise exception 'Unknown time zone.';
  end if;
  update public.ai_settings set
    quota_timezone = coalesce(p ->> 'quota_timezone', quota_timezone),
    max_input_chars = coalesce((p ->> 'max_input_chars')::integer, max_input_chars),
    max_output_tokens = coalesce((p ->> 'max_output_tokens')::integer, max_output_tokens),
    hourly_burst = coalesce((p ->> 'hourly_burst')::integer, hourly_burst),
    monthly_token_cap = case when p ? 'monthly_token_cap' then (p ->> 'monthly_token_cap')::bigint else monthly_token_cap end,
    usd_per_mtok_input = coalesce((p ->> 'usd_per_mtok_input')::numeric, usd_per_mtok_input),
    usd_per_mtok_output = coalesce((p ->> 'usd_per_mtok_output')::numeric, usd_per_mtok_output),
    updated_at = now();
  perform public.write_audit(null, 'update', 'ai_settings', 'settings', to_jsonb(old) - 'id', p);
end;
$$;
revoke execute on function public.platform_update_ai_settings(jsonb) from public, anon;
grant execute on function public.platform_update_ai_settings(jsonb) to authenticated;

create or replace function public.platform_set_ai_pool(p_inst uuid, p_enabled boolean, p_monthly_requests integer, p_monthly_token_cap bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can set AI credit pools.';
  end if;
  if not exists (select 1 from public.institutions where id = p_inst) then
    raise exception 'Institution not found.';
  end if;
  insert into public.institution_ai_pools (institution_id, enabled, monthly_requests, monthly_token_cap, updated_at)
  values (p_inst, p_enabled, p_monthly_requests, p_monthly_token_cap, now())
  on conflict (institution_id) do update set enabled = excluded.enabled, monthly_requests = excluded.monthly_requests,
    monthly_token_cap = excluded.monthly_token_cap, updated_at = now();
  perform public.write_audit(p_inst, 'update', 'ai_pool', p_inst::text, null,
    jsonb_build_object('enabled', p_enabled, 'monthly_requests', p_monthly_requests, 'monthly_token_cap', p_monthly_token_cap));
end;
$$;
revoke execute on function public.platform_set_ai_pool(uuid, boolean, integer, bigint) from public, anon;
grant execute on function public.platform_set_ai_pool(uuid, boolean, integer, bigint) to authenticated;

-- Platform owner may read AI configuration history in the audit log.
drop policy if exists "audit: read" on public.audit_log;
create policy "audit: read" on public.audit_log for select to authenticated
  using ((institution_id is not null and public.has_inst_perm(institution_id, 'view_audit'))
         or (public.is_platform_admin() and record_type in ('institutions', 'institution_email_allowlist', 'platform_admins',
                                                            'license_code', 'institution_license', 'plan', 'subscription',
                                                            'ai_feature', 'ai_quota', 'ai_settings', 'ai_pool')));
