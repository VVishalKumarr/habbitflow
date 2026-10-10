-- =====================================================================
-- Launch features: plans & subscriptions (server-enforced limits),
-- recovery email, username change, password checks, leaderboards,
-- sharing controls, exports, account deletion with password.
-- Additive only: no existing rows are changed or removed. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Rate limiting helper (security definer functions only)
-- ---------------------------------------------------------------------
create table if not exists public.rate_events (
  id         bigint generated always as identity primary key,
  key        text not null,
  action     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup_idx on public.rate_events (action, key, created_at);
alter table public.rate_events enable row level security;
revoke all on public.rate_events from anon, authenticated;

-- Records one event and returns true when the caller is over the limit.
create or replace function public.hit_rate_limit(p_key text, p_action text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.rate_events where created_at < now() - interval '1 day';
  select count(*) into n from public.rate_events
  where action = p_action and key = p_key and created_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then
    return true;
  end if;
  insert into public.rate_events (key, action) values (p_key, p_action);
  return false;
end;
$$;
revoke execute on function public.hit_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------
-- Plans: prices, limits and features live here so they can be changed
-- without touching app code. Limits: null = unlimited.
-- Prices are in the smallest currency unit (paise for INR).
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  id                     text primary key check (id in ('free', 'pro')),
  name                   text not null,
  currency               text not null default 'INR',
  price_monthly          integer not null default 0 check (price_monthly >= 0),
  price_yearly           integer not null default 0 check (price_yearly >= 0),
  trial_days             integer not null default 0 check (trial_days between 0 and 90),
  limits                 jsonb not null default '{}'::jsonb,
  features               text[] not null default '{}',
  razorpay_plan_monthly  text,
  razorpay_plan_yearly   text,
  stripe_price_monthly   text,
  stripe_price_yearly    text,
  google_play_product_id text,
  updated_at             timestamptz not null default now()
);

insert into public.plans (id, name, price_monthly, price_yearly, trial_days, limits, features) values
  ('free', 'Free', 0, 0, 0,
   '{"trackers": 2, "friends": 3, "history_days": 30}',
   array['basic_statistics']),
  ('pro', 'Pro', 9900, 79900, 7,
   '{"trackers": null, "friends": 50, "history_days": null}',
   array['basic_statistics', 'unlimited_trackers', 'advanced_statistics', 'full_history', 'custom_themes',
         'focus_sounds', 'csv_export', 'pdf_export', 'reports', 'leaderboards', 'friend_groups', 'no_ads'])
on conflict (id) do nothing;

alter table public.plans enable row level security;
drop policy if exists "plans: public read" on public.plans;
create policy "plans: public read" on public.plans for select to anon, authenticated using (true);
revoke all on public.plans from anon, authenticated;
grant select on public.plans to anon, authenticated;

-- ---------------------------------------------------------------------
-- Subscriptions: written only by the server (payment webhooks, trials).
-- Users can read their own rows; they can never insert or edit them.
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  provider                 text not null check (provider in ('razorpay', 'stripe', 'lemonsqueezy', 'google_play', 'trial', 'manual')),
  provider_subscription_id text,
  plan                     text not null default 'pro' references public.plans (id),
  status                   text not null check (status in ('created', 'trialing', 'active', 'past_due', 'cancelled', 'expired')),
  started_at               timestamptz,
  expires_at               timestamptz,
  cancel_at_period_end     boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated;
drop policy if exists "subscriptions: read own" on public.subscriptions;
create policy "subscriptions: read own" on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.subscriptions to authenticated;

-- The plan a user is entitled to right now. Only the server decides this.
create or replace function public.plan_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user
      and s.plan = 'pro'
      and (
        (s.status in ('active', 'trialing', 'past_due') and (s.expires_at is null or s.expires_at > now()))
        or (s.status = 'cancelled' and s.expires_at > now())
      )
  ) then 'pro' else 'free' end;
$$;

-- null = unlimited
create or replace function public.plan_limit(p_user uuid, p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (p.limits ->> p_key)::integer from public.plans p where p.id = public.plan_of(p_user);
$$;

create or replace function public.has_feature(p_user uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p_feature = any (p.features) from public.plans p where p.id = public.plan_of(p_user)), false);
$$;

revoke execute on function public.plan_of(uuid) from public, anon, authenticated;
revoke execute on function public.plan_limit(uuid, text) from public, anon, authenticated;
revoke execute on function public.has_feature(uuid, text) from public, anon, authenticated;

-- What the signed-in user is entitled to (drives the UI; the database
-- enforces the same rules independently).
create or replace function public.my_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  plan_id text;
  sub public.subscriptions;
  had_any boolean;
  state text;
  p public.plans;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  plan_id := public.plan_of(me);
  select * into p from public.plans where id = plan_id;
  select * into sub from public.subscriptions s where s.user_id = me and s.plan = 'pro'
    order by coalesce(s.expires_at, 'infinity'::timestamptz) desc, s.created_at desc limit 1;
  had_any := sub.id is not null;

  if plan_id = 'pro' then
    state := case when sub.status = 'trialing' then 'TRIAL' else 'PRO' end;
  elsif had_any then
    state := 'EXPIRED';
  else
    state := 'FREE';
  end if;

  return jsonb_build_object(
    'plan', plan_id,
    'state', state,
    'provider', sub.provider,
    'status', sub.status,
    'expires_at', sub.expires_at,
    'cancel_at_period_end', coalesce(sub.cancel_at_period_end, false),
    'limits', p.limits,
    'features', to_jsonb(p.features),
    'trial_available', (not had_any) and (select trial_days from public.plans where id = 'pro') > 0
  );
end;
$$;
revoke execute on function public.my_entitlements() from public, anon;
grant execute on function public.my_entitlements() to authenticated;

-- One free trial per account, if the Pro plan offers one.
create or replace function public.start_trial()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  days integer;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  select trial_days into days from public.plans where id = 'pro';
  if coalesce(days, 0) = 0 then
    raise exception 'Free trials are not available right now.';
  end if;
  if exists (select 1 from public.subscriptions where user_id = me) then
    raise exception 'Your free trial has already been used.';
  end if;
  insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at)
  values (me, 'trial', 'pro', 'trialing', now(), now() + make_interval(days => days));
  return public.my_entitlements();
end;
$$;
revoke execute on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

-- ---------------------------------------------------------------------
-- Server-side plan limits
-- Errors start with PLAN_LIMIT: or PRO_REQUIRED: so the app can offer an
-- upgrade. Existing data over a limit is never touched; only new rows
-- are blocked.
-- ---------------------------------------------------------------------
create or replace function public.enforce_tracker_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim integer := public.plan_limit(new.user_id, 'trackers');
begin
  if lim is not null and (select count(*) from public.trackers where user_id = new.user_id) >= lim then
    raise exception 'PLAN_LIMIT:trackers:%', lim using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists trackers_plan_limit on public.trackers;
create trigger trackers_plan_limit before insert on public.trackers
  for each row execute function public.enforce_tracker_limit();

-- ---------------------------------------------------------------------
-- Profile additions
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists accent_theme text not null default 'default';
alter table public.profiles add column if not exists leaderboard_opt_in boolean not null default false;
-- Friends see daily totals (completion %, focus time) only while this is on.
alter table public.profiles add column if not exists share_progress boolean not null default true;

do $$ begin
  alter table public.profiles add constraint profiles_accent_theme_check
    check (accent_theme in ('default', 'ocean', 'forest', 'sunset', 'midnight', 'minimal'));
exception when duplicate_object then null; end $$;

create or replace function public.enforce_profile_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.accent_theme <> old.accent_theme and new.accent_theme <> 'default'
     and not public.has_feature(new.id, 'custom_themes') then
    raise exception 'PRO_REQUIRED:custom_themes' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists profiles_rules on public.profiles;
create trigger profiles_rules before update on public.profiles
  for each row execute function public.enforce_profile_rules();

grant update (accent_theme, leaderboard_opt_in, share_progress) on public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- Private account data (recovery email). No direct client access:
-- read through my_account(), written by server functions only.
-- ---------------------------------------------------------------------
create table if not exists public.account_private (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  recovery_email     text check (recovery_email is null or recovery_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  email_verified_at  timestamptz,
  pending_email      text check (pending_email is null or pending_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  pending_token_hash text,
  pending_expires_at timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists account_private_email_idx on public.account_private (lower(recovery_email));
alter table public.account_private enable row level security;
revoke all on public.account_private from anon, authenticated;

create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'username', p.username,
    'recovery_email', a.recovery_email,
    'email_verified', a.email_verified_at is not null,
    'pending_email', case when a.pending_expires_at > now() then a.pending_email end
  )
  from public.profiles p
  left join public.account_private a on a.user_id = p.id
  where p.id = auth.uid();
$$;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated;

-- Checks the signed-in user's current password (bcrypt, via pgcrypto).
-- Five wrong attempts in 15 minutes locks further checks for a while.
create or replace function public.check_password(p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  ok boolean;
  failures integer;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  select count(*) into failures from public.rate_events
  where action = 'password_fail' and key = me::text and created_at > now() - interval '15 minutes';
  if failures >= 5 then
    raise exception 'Too many attempts. Please wait 15 minutes and try again.';
  end if;
  select u.encrypted_password = extensions.crypt(coalesce(p_password, ''), u.encrypted_password)
    into ok from auth.users u where u.id = me;
  if not coalesce(ok, false) then
    insert into public.rate_events (key, action) values (me::text, 'password_fail');
    return false;
  end if;
  return true;
end;
$$;
revoke execute on function public.check_password(text) from public, anon;
grant execute on function public.check_password(text) to authenticated;

-- Confirms a recovery email from the link in the verification email.
-- The token is random (32 bytes), stored only as a SHA-256 hash, expires
-- after 24 hours and works once. Works signed in or out.
create or replace function public.confirm_recovery_email(p_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_user uuid;
  new_email text;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'This verification link is invalid.';
  end if;
  update public.account_private a
     set recovery_email = a.pending_email,
         email_verified_at = now(),
         pending_email = null,
         pending_token_hash = null,
         pending_expires_at = null,
         updated_at = now()
   where a.pending_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and a.pending_expires_at > now()
  returning a.user_id, a.recovery_email into row_user, new_email;
  if row_user is null then
    raise exception 'This verification link is invalid or has expired.';
  end if;
  return new_email;
end;
$$;
revoke execute on function public.confirm_recovery_email(text) from public;
grant execute on function public.confirm_recovery_email(text) to anon, authenticated;

-- Wrong-password paths return false instead of raising, so the failed
-- attempt recorded by check_password is not rolled back.
drop function if exists public.remove_recovery_email(text);
create or replace function public.remove_recovery_email(p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.check_password(p_password) then
    return false;
  end if;
  update public.account_private
     set recovery_email = null, email_verified_at = null, pending_email = null,
         pending_token_hash = null, pending_expires_at = null, updated_at = now()
   where user_id = auth.uid();
  return true;
end;
$$;
revoke execute on function public.remove_recovery_email(text) from public, anon;
grant execute on function public.remove_recovery_email(text) to authenticated;

create or replace function public.cancel_pending_email()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.account_private
     set pending_email = null, pending_token_hash = null, pending_expires_at = null, updated_at = now()
   where user_id = auth.uid();
$$;
revoke execute on function public.cancel_pending_email() from public, anon;
grant execute on function public.cancel_pending_email() to authenticated;

-- ---------------------------------------------------------------------
-- Change username: same account, same id, so trackers, tasks, friends and
-- subscriptions are untouched. The hidden login address follows the name.
-- ---------------------------------------------------------------------
drop function if exists public.change_username(text, text);
create or replace function public.change_username(p_new text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  uname text := lower(btrim(coalesce(p_new, '')));
  login text;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if uname !~ '^[a-z0-9_.-]{3,24}$' then
    raise exception 'Use 3–24 letters, numbers, dots, dashes or underscores.';
  end if;
  if not public.check_password(p_password) then
    return jsonb_build_object('ok', false, 'error', 'Current password is incorrect.');
  end if;
  if uname = (select username from public.profiles where id = me) then
    raise exception 'That is already your username.';
  end if;
  if exists (select 1 from public.profiles where username = uname) then
    raise exception 'That username is already taken.';
  end if;
  login := uname || '@habitflow.local';
  if exists (select 1 from auth.users where lower(email) = login and id <> me) then
    raise exception 'That username is already taken.';
  end if;

  update public.profiles set username = uname where id = me;
  update auth.users set email = login, updated_at = now() where id = me;
  update auth.identities
     set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(login)), updated_at = now()
   where user_id = me and provider = 'email';
  return jsonb_build_object('ok', true, 'username', uname);
end;
$$;
revoke execute on function public.change_username(text, text) from public, anon;
grant execute on function public.change_username(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Account deletion with password. Paid subscriptions must be cancelled
-- with the payment provider first (the delete-account server function
-- does that automatically when deployed).
-- ---------------------------------------------------------------------
drop function if exists public.delete_account_confirmed(text);
create or replace function public.delete_account_confirmed(p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if not public.check_password(p_password) then
    return false;
  end if;
  if exists (
    select 1 from public.subscriptions
    where user_id = me and provider in ('razorpay', 'stripe', 'lemonsqueezy', 'google_play')
      and status in ('active', 'trialing', 'past_due') and not cancel_at_period_end
  ) then
    raise exception 'Please cancel your Pro subscription before deleting your account.';
  end if;
  delete from auth.users where id = me;
  return true;
end;
$$;
revoke execute on function public.delete_account_confirmed(text) from public, anon;
grant execute on function public.delete_account_confirmed(text) to authenticated;

-- ---------------------------------------------------------------------
-- Friends: plan limits, sharing control, leaderboard
-- ---------------------------------------------------------------------
create or replace function public.friend_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.friendships f
  where (f.status = 'accepted' and p_user in (f.requester_id, f.addressee_id))
     or (f.status = 'pending' and f.requester_id = p_user);
$$;
revoke execute on function public.friend_count(uuid) from public, anon, authenticated;

create or replace function public.send_friend_request(p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  them uuid;
  existing public.friendships;
  lim integer;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if public.hit_rate_limit(me::text, 'friend_request', 30, 3600) then
    raise exception 'Too many friend requests. Please try again later.';
  end if;
  select p.id into them from public.profiles p where p.username = lower(btrim(p_username));
  if them is null then
    raise exception 'No user with that username.';
  end if;
  if them = me then
    raise exception 'You can''t add yourself.';
  end if;

  select * into existing from public.friendships f
  where least(f.requester_id, f.addressee_id) = least(me, them)
    and greatest(f.requester_id, f.addressee_id) = greatest(me, them);

  if existing.id is not null then
    if existing.status = 'accepted' then
      raise exception 'You are already friends.';
    elsif existing.requester_id = me then
      raise exception 'Friend request already sent.';
    end if;
    lim := public.plan_limit(me, 'friends');
    if lim is not null and public.friend_count(me) >= lim then
      raise exception 'PLAN_LIMIT:friends:%', lim using errcode = 'P0001';
    end if;
    update public.friendships set status = 'accepted', responded_at = now() where id = existing.id;
    return 'accepted';
  end if;

  lim := public.plan_limit(me, 'friends');
  if lim is not null and public.friend_count(me) >= lim then
    raise exception 'PLAN_LIMIT:friends:%', lim using errcode = 'P0001';
  end if;
  insert into public.friendships (requester_id, addressee_id) values (me, them);
  return 'sent';
end;
$$;

create or replace function public.respond_friend_request(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_accept then
    lim := public.plan_limit(auth.uid(), 'friends');
    if lim is not null and public.friend_count(auth.uid()) >= lim then
      raise exception 'PLAN_LIMIT:friends:%', lim using errcode = 'P0001';
    end if;
    update public.friendships set status = 'accepted', responded_at = now()
    where id = p_id and addressee_id = auth.uid() and status = 'pending';
  else
    delete from public.friendships
    where id = p_id and addressee_id = auth.uid() and status = 'pending';
  end if;
  if not found then
    raise exception 'That request is no longer available.';
  end if;
end;
$$;

-- list_friends now also says whether each friend shares progress.
drop function if exists public.list_friends();
create or replace function public.list_friends()
returns table (id uuid, friend_id uuid, username text, status text, incoming boolean, created_at timestamptz, shares_progress boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id,
         p.id,
         p.username,
         f.status,
         f.addressee_id = auth.uid(),
         f.created_at,
         f.status = 'accepted' and p.share_progress
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() in (f.requester_id, f.addressee_id)
  order by f.status, p.username;
$$;
revoke execute on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;

-- Comparison: friend must share progress; free plans are limited to their history window.
create or replace function public.compare_progress(p_friend uuid, p_from date, p_to date, p_tz text default 'UTC')
returns table (
  user_id         uuid,
  day             date,
  focus_seconds   integer,
  sessions        integer,
  tasks_scheduled integer,
  tasks_completed integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
  hist integer;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if p_friend <> me and not public.are_friends(me, p_friend) then
    raise exception 'You can only compare with friends.';
  end if;
  if p_friend <> me and not (select share_progress from public.profiles where id = p_friend) then
    raise exception 'This friend isn''t sharing their progress.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Invalid date range.';
  end if;
  hist := public.plan_limit(me, 'history_days');
  if hist is not null and p_to - p_from + 1 > hist then
    raise exception 'PRO_REQUIRED:advanced_statistics' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = tz) then
    tz := 'UTC';
  end if;

  return query
  with days as (
    select d::date as d_day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  people as (
    select distinct unnest(array[me, p_friend]) as uid
  ),
  sched as (
    select t.user_id as uid, dd.d_day,
           count(*)::int as scheduled,
           (count(*) filter (where c.completed))::int as done
    from days dd
    join public.tasks t
      on t.user_id in (me, p_friend)
     and t.day_of_week = extract(dow from dd.d_day)::int
    left join public.task_completions c
      on c.task_id = t.id and c.completion_date = dd.d_day
    where dd.d_day >= (t.created_at at time zone tz)::date or c.completed
    group by t.user_id, dd.d_day
  ),
  focus as (
    select s.user_id as uid, s.session_date as d_day,
           sum(s.focus_seconds)::int as secs,
           count(*)::int as n
    from public.pomodoro_sessions s
    where s.user_id in (me, p_friend) and s.session_date between p_from and p_to
    group by s.user_id, s.session_date
  )
  select p.uid, dd.d_day,
         coalesce(f.secs, 0), coalesce(f.n, 0),
         coalesce(s.scheduled, 0), coalesce(s.done, 0)
  from people p
  cross join days dd
  left join sched s on s.uid = p.uid and s.d_day = dd.d_day
  left join focus f on f.uid = p.uid and f.d_day = dd.d_day
  order by p.uid, dd.d_day;
end;
$$;

-- Weekly leaderboard among you and friends who opted in (Pro feature).
-- Only totals: completion rate, tasks done, focus minutes. No task names.
create or replace function public.friends_leaderboard(p_tz text default 'UTC')
returns table (username text, is_me boolean, completion_rate numeric, tasks_completed integer, focus_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
  today date;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if not public.has_feature(me, 'leaderboards') then
    raise exception 'PRO_REQUIRED:leaderboards' using errcode = 'P0001';
  end if;
  if not (select leaderboard_opt_in from public.profiles where id = me) then
    raise exception 'Turn on leaderboard participation in Settings first.';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = tz) then
    tz := 'UTC';
  end if;
  today := (now() at time zone tz)::date;

  return query
  with members as (
    select p.id as uid, p.username as uname from public.profiles p
    where p.id = me
       or (p.leaderboard_opt_in and public.are_friends(me, p.id))
  ),
  days as (
    select d::date as d_day from generate_series((today - 6)::timestamp, today::timestamp, interval '1 day') d
  ),
  sched as (
    select t.user_id as uid, count(*)::int as scheduled, (count(*) filter (where c.completed))::int as done
    from days dd
    join public.tasks t on t.user_id in (select uid from members) and t.day_of_week = extract(dow from dd.d_day)::int
    left join public.task_completions c on c.task_id = t.id and c.completion_date = dd.d_day
    where dd.d_day >= (t.created_at at time zone tz)::date or c.completed
    group by t.user_id
  ),
  focus as (
    select s.user_id as uid, (sum(s.focus_seconds) / 60)::int as mins
    from public.pomodoro_sessions s
    where s.user_id in (select uid from members) and s.session_date between today - 6 and today
    group by s.user_id
  )
  select m.uname, m.uid = me,
         case when coalesce(s.scheduled, 0) = 0 then 0 else round(s.done::numeric / s.scheduled, 4) end,
         coalesce(s.done, 0), coalesce(f.mins, 0)
  from members m
  left join sched s on s.uid = m.uid
  left join focus f on f.uid = m.uid
  order by 3 desc, 5 desc, 1;
end;
$$;
revoke execute on function public.friends_leaderboard(text) from public, anon;
grant execute on function public.friends_leaderboard(text) to authenticated;

-- ---------------------------------------------------------------------
-- Export (Pro): one row per scheduled task occurrence in the range,
-- from the caller's own data only.
-- ---------------------------------------------------------------------
drop function if exists public.export_timetable(date, date, text);
create or replace function public.export_timetable(p_from date, p_to date, p_tz text default 'UTC')
returns table (day date, tracker_id uuid, tracker text, task text, category text, weekday smallint, start_time time, end_time time, completed boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if not public.has_feature(me, 'csv_export') then
    raise exception 'PRO_REQUIRED:csv_export' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a range of up to one year.';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = tz) then
    tz := 'UTC';
  end if;
  return query
  select dd::date, tr.id, tr.name, t.title, t.category, t.day_of_week, s.start_time, s.end_time, coalesce(c.completed, false)
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') dd
  join public.tasks t on t.user_id = me and t.day_of_week = extract(dow from dd)::int
  join public.trackers tr on tr.id = t.tracker_id
  join public.time_slots s on s.id = t.time_slot_id
  left join public.task_completions c on c.task_id = t.id and c.completion_date = dd::date
  where dd::date >= (t.created_at at time zone tz)::date or c.completed
  order by dd, tr.name, s.start_time;
end;
$$;
revoke execute on function public.export_timetable(date, date, text) from public, anon;
grant execute on function public.export_timetable(date, date, text) to authenticated;
