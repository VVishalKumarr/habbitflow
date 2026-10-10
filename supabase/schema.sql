-- =====================================================================
-- HabitFlow database schema (Supabase / PostgreSQL)
--
-- Security model
--  * Accounts live in Supabase Auth (auth.users). Passwords are hashed
--    with bcrypt by Supabase and never touch these tables.
--  * The app only asks for username + password. Internally a username is
--    mapped to the synthetic login "<username>@habitflow.local"; the
--    trigger below rejects any sign-up that does not follow that shape.
--  * Every data table carries user_id and has Row Level Security that only
--    exposes rows where user_id = auth.uid().
--  * Composite foreign keys (tracker_id, user_id) etc. guarantee a row can
--    never reference a tracker / slot / task that belongs to someone else.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- profiles: one row per auth user (username + preferences)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  username        text not null unique check (username ~ '^[a-z0-9_.-]{3,24}$'),
  week_start      smallint not null default 0 check (week_start in (0, 1)),
  time_format     text not null default '12h' check (time_format in ('12h', '24h')),
  theme           text not null default 'light' check (theme in ('light', 'dark')),
  last_tracker_id uuid,
  created_at      timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
begin
  if uname !~ '^[a-z0-9_.-]{3,24}$' then
    raise exception 'Invalid username';
  end if;
  if lower(new.email) <> uname || '@habitflow.local' then
    raise exception 'Username does not match login';
  end if;
  insert into public.profiles (id, username) values (new.id, uname);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- trackers
-- ---------------------------------------------------------------------
create table if not exists public.trackers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists trackers_user_idx on public.trackers (user_id, created_at);

drop trigger if exists trackers_updated_at on public.trackers;
create trigger trackers_updated_at before update on public.trackers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- time_slots: arbitrary [start, end) ranges per tracker
-- ---------------------------------------------------------------------
create table if not exists public.time_slots (
  id         uuid primary key default gen_random_uuid(),
  tracker_id uuid not null,
  user_id    uuid not null default auth.uid(),
  start_time time not null,
  end_time   time not null,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  unique (id, tracker_id),
  foreign key (tracker_id, user_id) references public.trackers (id, user_id) on delete cascade
);
create index if not exists time_slots_tracker_idx on public.time_slots (tracker_id, start_time);
create index if not exists time_slots_user_idx on public.time_slots (user_id);

-- Reject overlapping slots inside the same tracker (touching edges are fine).
create or replace function public.check_time_slot_overlap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.time_slots s
    where s.tracker_id = new.tracker_id
      and s.id <> new.id
      and s.start_time < new.end_time
      and new.start_time < s.end_time
  ) then
    raise exception 'Time slot overlaps an existing slot' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists time_slots_no_overlap on public.time_slots;
create trigger time_slots_no_overlap before insert or update on public.time_slots
  for each row execute function public.check_time_slot_overlap();

-- ---------------------------------------------------------------------
-- tasks: recurring weekly entries (tracker + slot + weekday)
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  tracker_id   uuid not null,
  user_id      uuid not null default auth.uid(),
  time_slot_id uuid not null,
  day_of_week  smallint not null check (day_of_week between 0 and 6), -- 0 = Sunday
  title        text not null check (char_length(btrim(title)) between 1 and 100),
  description  text check (description is null or char_length(description) <= 500),
  category     text not null default 'other'
               check (category in ('study', 'exercise', 'work', 'personal', 'other')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id),
  unique (id, tracker_id),
  foreign key (tracker_id, user_id) references public.trackers (id, user_id) on delete cascade,
  foreign key (time_slot_id, tracker_id) references public.time_slots (id, tracker_id) on delete cascade
);
create index if not exists tasks_tracker_idx on public.tasks (tracker_id);
create index if not exists tasks_slot_idx on public.tasks (time_slot_id);
create index if not exists tasks_user_idx on public.tasks (user_id);

drop trigger if exists tasks_updated_at on public.tasks;
create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- task_completions: one row per task per calendar date
-- ---------------------------------------------------------------------
create table if not exists public.task_completions (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null,
  tracker_id      uuid not null,
  user_id         uuid not null default auth.uid(),
  completion_date date not null,
  completed       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (task_id, completion_date),
  foreign key (task_id, user_id) references public.tasks (id, user_id) on delete cascade,
  foreign key (task_id, tracker_id) references public.tasks (id, tracker_id) on delete cascade
);
create index if not exists completions_tracker_date_idx on public.task_completions (tracker_id, completion_date);
create index if not exists completions_user_idx on public.task_completions (user_id);

drop trigger if exists task_completions_updated_at on public.task_completions;
create trigger task_completions_updated_at before update on public.task_completions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.trackers         enable row level security;
alter table public.time_slots       enable row level security;
alter table public.tasks            enable row level security;
alter table public.task_completions enable row level security;

-- Anonymous visitors get nothing.
revoke all on public.profiles, public.trackers, public.time_slots, public.tasks, public.task_completions from anon;

-- profiles: read own row, update only preference columns.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke insert, update, delete on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (week_start, time_format, theme, last_tracker_id) on public.profiles to authenticated;

-- Data tables: full CRUD on own rows only.
do $$
declare t text;
begin
  foreach t in array array['trackers', 'time_slots', 'tasks', 'task_completions'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Account deletion (removes the auth user; everything else cascades)
-- ---------------------------------------------------------------------
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- =====================================================================
-- Pomodoro focus sessions
-- =====================================================================
create table if not exists public.pomodoro_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label           text not null check (char_length(btrim(label)) between 1 and 100),
  planned_minutes smallint not null check (planned_minutes between 1 and 240),
  focus_seconds   integer not null check (focus_seconds between 60 and 14400),
  -- true = the timer ran to the end, false = the user finished early
  completed       boolean not null default true,
  -- local calendar date the session ended on (client time zone)
  session_date    date not null,
  started_at      timestamptz not null,
  ended_at        timestamptz not null,
  created_at      timestamptz not null default now(),
  check (ended_at >= started_at)
);
create index if not exists pomodoro_user_date_idx on public.pomodoro_sessions (user_id, session_date);

alter table public.pomodoro_sessions enable row level security;
revoke all on public.pomodoro_sessions from anon;
drop policy if exists "own rows" on public.pomodoro_sessions;
create policy "own rows" on public.pomodoro_sessions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, delete on public.pomodoro_sessions to authenticated;

-- =====================================================================
-- Friends
--  * One row per pair of users, whichever direction the request went.
--  * Rows are only created / accepted through the functions below, so a
--    user can never browse profiles or fake an accepted friendship.
--  * Either side can read the row and delete it (decline / cancel / unfriend).
-- =====================================================================
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

alter table public.friendships enable row level security;
revoke all on public.friendships from anon, authenticated;
drop policy if exists "parties read" on public.friendships;
create policy "parties read" on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));
drop policy if exists "parties delete" on public.friendships;
create policy "parties delete" on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));
grant select, delete on public.friendships to authenticated;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = least(a, b)
      and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
  );
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- Send a request by username. If they already asked you, this accepts it.
-- Returns 'sent' or 'accepted'.
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
begin
  if me is null then
    raise exception 'Not authenticated';
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
    update public.friendships set status = 'accepted', responded_at = now() where id = existing.id;
    return 'accepted';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (me, them);
  return 'sent';
end;
$$;

-- Accept or decline a request addressed to you.
create or replace function public.respond_friend_request(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_accept then
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

-- Your friends and pending requests, with the other person's username.
create or replace function public.list_friends()
returns table (id uuid, friend_id uuid, username text, status text, incoming boolean, created_at timestamptz)
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
         f.created_at
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where auth.uid() in (f.requester_id, f.addressee_id)
  order by f.status, p.username;
$$;

-- Daily Pomodoro and timetable totals for you and one friend, for comparison.
-- p_tz is the viewer's IANA time zone, used to date each task's creation.
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
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if p_friend <> me and not public.are_friends(me, p_friend) then
    raise exception 'You can only compare with friends.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Invalid date range.';
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

revoke execute on function public.send_friend_request(text) from public, anon;
revoke execute on function public.respond_friend_request(uuid, boolean) from public, anon;
revoke execute on function public.list_friends() from public, anon;
revoke execute on function public.compare_progress(uuid, date, date, text) from public, anon;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.list_friends() to authenticated;
grant execute on function public.compare_progress(uuid, date, date, text) to authenticated;

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

-- =====================================================================
-- Three plans (Free, Plus, Pro) with regional prices.
-- * plans.prices: per-region prices in the smallest currency unit, e.g.
--   {"IN": {"currency": "INR", "monthly": 4900, "yearly": 39900},
--    "default": {"currency": "USD", "monthly": 199, "yearly": 1499}}
--   "default" applies to every region without its own entry.
-- * plans.rank orders plans (free 0 < plus 1 < pro 2); a user is entitled
--   to the highest-ranked plan they have an active subscription for.
-- Existing subscriptions keep working (they are all 'pro' or trials).
-- Safe to re-run: prices you have edited since are not overwritten.
-- =====================================================================

alter table public.plans drop constraint if exists plans_id_check;
alter table public.plans add constraint plans_id_check check (id ~ '^[a-z][a-z0-9_]{1,30}$');
alter table public.plans add column if not exists rank smallint not null default 0;
alter table public.plans add column if not exists prices jsonb not null default '{}'::jsonb;

insert into public.plans (id, name, rank, price_monthly, price_yearly, trial_days, limits, features) values
  ('plus', 'Plus', 1, 4900, 39900, 0,
   '{"trackers": null, "friends": 10, "history_days": null}',
   array['basic_statistics', 'unlimited_trackers', 'advanced_statistics', 'full_history', 'custom_themes', 'no_ads'])
on conflict (id) do nothing;

update public.plans set rank = 0 where id = 'free';
update public.plans set rank = 1 where id = 'plus';
update public.plans set rank = 2 where id = 'pro';

-- Seed regional prices only where none are set yet.
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 0, "yearly": 0}, "default": {"currency": "USD", "monthly": 0, "yearly": 0}}'
  where id = 'free' and prices = '{}'::jsonb;
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 4900, "yearly": 39900}, "default": {"currency": "USD", "monthly": 199, "yearly": 1499}}'
  where id = 'plus' and prices = '{}'::jsonb;
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 9900, "yearly": 79900}, "default": {"currency": "USD", "monthly": 399, "yearly": 2999}}'
  where id = 'pro' and prices = '{}'::jsonb;

-- The highest-ranked plan with an active subscription, else 'free'.
create or replace function public.plan_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p.id
    from public.subscriptions s
    join public.plans p on p.id = s.plan
    where s.user_id = p_user
      and (
        (s.status in ('active', 'trialing', 'past_due') and (s.expires_at is null or s.expires_at > now()))
        or (s.status = 'cancelled' and s.expires_at > now())
      )
    order by p.rank desc
    limit 1
  ), 'free');
$$;
revoke execute on function public.plan_of(uuid) from public, anon, authenticated;

-- state: FREE (never paid) · TRIAL · ACTIVE (paid plan) · EXPIRED (had a paid plan, now free)
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
  had_any := exists (select 1 from public.subscriptions where user_id = me and plan <> 'free');

  if plan_id <> 'free' then
    -- the subscription that grants the current plan (latest expiry first)
    select * into sub from public.subscriptions s
    where s.user_id = me and s.plan = plan_id
      and (
        (s.status in ('active', 'trialing', 'past_due') and (s.expires_at is null or s.expires_at > now()))
        or (s.status = 'cancelled' and s.expires_at > now())
      )
    order by coalesce(s.expires_at, 'infinity'::timestamptz) desc
    limit 1;
    state := case when sub.status = 'trialing' then 'TRIAL' else 'ACTIVE' end;
  elsif had_any then
    state := 'EXPIRED';
  else
    state := 'FREE';
  end if;

  return jsonb_build_object(
    'plan', plan_id,
    'plan_name', p.name,
    'rank', p.rank,
    'state', state,
    'provider', sub.provider,
    'status', sub.status,
    'expires_at', sub.expires_at,
    'cancel_at_period_end', coalesce(sub.cancel_at_period_end, false),
    'limits', p.limits,
    'features', to_jsonb(p.features),
    'trial_available', (not had_any) and exists (select 1 from public.plans where trial_days > 0)
  );
end;
$$;
revoke execute on function public.my_entitlements() from public, anon;
grant execute on function public.my_entitlements() to authenticated;

-- One free trial per account, of the highest plan that offers one.
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
  if exists (select 1 from public.subscriptions where user_id = me) then
    raise exception 'Your free trial has already been used.';
  end if;
  insert into public.subscriptions (user_id, provider, plan, status, started_at, expires_at)
  values (me, 'trial', tp.id, 'trialing', now(), now() + make_interval(days => tp.trial_days));
  return public.my_entitlements();
end;
$$;
revoke execute on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

-- delete_account_confirmed and others already treat any paid-provider
-- subscription the same way, whatever its plan.

-- =====================================================================
-- Institutions — Phase 1: foundation and institutional administration.
--
-- * Institutional accounts use a real, allowlisted email address. They are
--   created only by the institution-activate server function after the
--   person opens a one-time activation link (see handle_new_user below).
--   Public sign-up with a real email address is rejected.
-- * Every institution-owned row carries institution_id. Row Level Security
--   uses the helper functions in this file; the browser filters nothing.
-- * Roles: principal / director (heads), coordinator / class_teacher
--   (same tier, different permissions), subject_teacher, student, parent.
--   The platform owner (platform_admins) is outside the hierarchy and does
--   not get access to academic records.
-- * audit_log is append-only for every client role.
-- Additive only: existing tables and rows are untouched. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profiles: account type + display name
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists account_type text not null default 'individual';
alter table public.profiles add column if not exists display_name text;
do $$ begin
  alter table public.profiles add constraint profiles_account_type_check check (account_type in ('individual', 'institutional'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_display_name_check
    check (display_name is null or char_length(btrim(display_name)) between 1 and 80);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id             bigint generated always as identity primary key,
  institution_id uuid,
  actor_id       uuid,
  action         text not null check (char_length(action) between 1 and 60),
  record_type    text not null check (char_length(record_type) between 1 and 60),
  record_id      text,
  old_value      jsonb,
  new_value      jsonb,
  reason         text check (reason is null or char_length(reason) <= 500),
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists audit_log_inst_idx on public.audit_log (institution_id, created_at desc);
create index if not exists audit_log_record_idx on public.audit_log (record_type, record_id);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

-- Server functions pass the acting user explicitly; this resolves it.
create or replace function public.current_actor()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.uid(), nullif(current_setting('habitflow.actor', true), '')::uuid);
$$;

create or replace function public.write_audit(
  p_inst uuid, p_action text, p_type text, p_id text,
  p_old jsonb default null, p_new jsonb default null, p_reason text default null, p_meta jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (institution_id, actor_id, action, record_type, record_id, old_value, new_value, reason, metadata)
  values (p_inst, public.current_actor(), p_action, p_type, p_id, p_old, p_new, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));
$$;
revoke execute on function public.write_audit(uuid, text, text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;

-- Generic row trigger: records inserts, deletes and the changed columns of updates.
-- Secrets (token hashes) are never copied into the log.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - 'token_hash' - 'updated_at' end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - 'token_hash' - 'updated_at' end;
  diff jsonb;
  rec jsonb;
  inst uuid;
begin
  if tg_op = 'UPDATE' then
    if o = n then
      return new;
    end if;
    select coalesce(jsonb_object_agg(k, o -> k), '{}'::jsonb) into diff
      from jsonb_object_keys(o) k where (o -> k) is distinct from (n -> k);
    select coalesce(jsonb_object_agg(k, n -> k), '{}'::jsonb) into n
      from jsonb_object_keys(n) k where (o -> k) is distinct from (n -> k);
    o := diff;
  end if;
  rec := coalesce(to_jsonb(new), to_jsonb(old));
  inst := case when tg_table_name = 'institutions' then (rec ->> 'id')::uuid else (rec ->> 'institution_id')::uuid end;
  insert into public.audit_log (institution_id, actor_id, action, record_type, record_id, old_value, new_value, reason)
  values (inst, public.current_actor(), lower(tg_op), tg_table_name, rec ->> 'id', o, n,
          nullif(current_setting('habitflow.audit_reason', true), ''));
  return coalesce(new, old);
end;
$$;

-- Records never move from one institution to another.
create or replace function public.keep_institution_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.institution_id is distinct from old.institution_id then
    raise exception 'Records cannot be moved between institutions.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Platform owner (outside the institutional hierarchy)
-- Granted only with SQL by the owner: see INSTITUTION_ONBOARDING.md.
-- ---------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;

create or replace function public.is_platform_admin_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where user_id = p_user);
$$;
revoke execute on function public.is_platform_admin_user(uuid) from public, anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_platform_admin_user(auth.uid());
$$;
revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------
-- Institutions
-- ---------------------------------------------------------------------
create table if not exists public.institutions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 120),
  short_name  text check (short_name is null or char_length(btrim(short_name)) between 1 and 30),
  kind        text not null default 'school' check (kind in ('school', 'college', 'coaching', 'other')),
  status      text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  timezone    text not null default 'Asia/Kolkata' check (char_length(timezone) between 1 and 64),
  logo_url    text check (logo_url is null or (logo_url ~ '^https://[^\s"''<>]+$' and char_length(logo_url) <= 500)),
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  settings    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Settings with defaults filled in. Limits are enforced by validate_institution().
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
    'grading_scale', jsonb_build_array(
      jsonb_build_object('label', 'A1', 'min', 91), jsonb_build_object('label', 'A2', 'min', 81),
      jsonb_build_object('label', 'B1', 'min', 71), jsonb_build_object('label', 'B2', 'min', 61),
      jsonb_build_object('label', 'C1', 'min', 51), jsonb_build_object('label', 'C2', 'min', 41),
      jsonb_build_object('label', 'D', 'min', 33), jsonb_build_object('label', 'E', 'min', 0)),
    'attendance_statuses', jsonb_build_array('present', 'absent', 'late', 'excused')
  ) || coalesce((select settings from public.institutions where id = p_inst), '{}'::jsonb);
$$;
revoke execute on function public.institution_settings(uuid) from public, anon;
grant execute on function public.institution_settings(uuid) to authenticated;

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
    if k not in ('homework_retention_days', 'max_deadlines_per_day', 'max_deadlines_per_week', 'grading_scale', 'attendance_statuses') then
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
drop trigger if exists institutions_validate on public.institutions;
create trigger institutions_validate before insert or update on public.institutions
  for each row execute function public.validate_institution();

-- ---------------------------------------------------------------------
-- Approved institutional email addresses and domains
-- ---------------------------------------------------------------------
create table if not exists public.institution_email_allowlist (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  kind           text not null check (kind in ('email', 'domain')),
  value          text not null,
  status         text not null default 'active' check (status in ('active', 'revoked')),
  note           text check (note is null or char_length(note) <= 200),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  check (value = lower(btrim(value))),
  check ((kind = 'email' and value ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$')
      or (kind = 'domain' and value ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')),
  unique (institution_id, kind, value)
);
create index if not exists allowlist_value_idx on public.institution_email_allowlist (value) where status = 'active';

-- Public mail providers can never be allowlisted as a whole domain.
create or replace function public.validate_allowlist()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'domain' and new.value in ('gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com',
     'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com',
     'zoho.com', 'gmx.com', 'mail.com', 'yandex.com', 'habitflow.local') then
    raise exception 'Public email providers can''t be approved as a whole domain. Add individual addresses instead.';
  end if;
  if new.value like '%@habitflow.local' then
    raise exception 'That address is reserved.';
  end if;
  new.revoked_at := case when new.status = 'revoked' then coalesce(new.revoked_at, now()) end;
  return new;
end;
$$;
drop trigger if exists allowlist_validate on public.institution_email_allowlist;
create trigger allowlist_validate before insert or update on public.institution_email_allowlist
  for each row execute function public.validate_allowlist();

create or replace function public.email_allowlisted(p_inst uuid, p_email text, p_exact_only boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.institution_email_allowlist a
    where a.institution_id = p_inst and a.status = 'active'
      and ((a.kind = 'email' and a.value = lower(btrim(p_email)))
        or (not p_exact_only and a.kind = 'domain' and split_part(lower(btrim(p_email)), '@', 2) = a.value))
  );
$$;
revoke execute on function public.email_allowlisted(uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Memberships: one per person per institution. Never hard-deleted by the
-- app; access is removed by suspending or revoking.
-- ---------------------------------------------------------------------
create table if not exists public.institution_memberships (
  id                uuid primary key default gen_random_uuid(),
  institution_id    uuid not null references public.institutions (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,
  role              text not null check (role in ('principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher', 'student', 'parent')),
  status            text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  display_name      text not null check (char_length(btrim(display_name)) between 1 and 80),
  external_id       text check (external_id is null or char_length(btrim(external_id)) between 1 and 40),
  status_reason     text check (status_reason is null or char_length(status_reason) <= 500),
  status_changed_at timestamptz,
  activated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, institution_id)
);
create unique index if not exists memberships_user_inst_idx on public.institution_memberships (institution_id, user_id) where user_id is not null;
create index if not exists memberships_user_idx on public.institution_memberships (user_id);
create index if not exists memberships_inst_role_idx on public.institution_memberships (institution_id, role, status);

-- Role helpers
create or replace function public.is_staff_role(p_role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher');
$$;

-- The active role of a user in an institution (null = no active access).
create or replace function public.inst_role_for(p_user uuid, p_inst uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.institution_memberships m
  join public.institutions i on i.id = m.institution_id
  where m.institution_id = p_inst and m.user_id = p_user and m.status = 'active' and i.status = 'active'
  limit 1;
$$;
revoke execute on function public.inst_role_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.inst_role(p_inst uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.inst_role_for(auth.uid(), p_inst);
$$;
revoke execute on function public.inst_role(uuid) from public, anon;
grant execute on function public.inst_role(uuid) to authenticated;

create or replace function public.my_membership_id(p_inst uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.institution_memberships m
  join public.institutions i on i.id = m.institution_id
  where m.institution_id = p_inst and m.user_id = auth.uid() and m.status = 'active' and i.status = 'active'
  limit 1;
$$;
revoke execute on function public.my_membership_id(uuid) from public, anon;
grant execute on function public.my_membership_id(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Permissions: defaults per role, configurable per institution for the
-- coordinator, class teacher and subject teacher roles only.
-- Heads always have every permission; the locked permissions can never be
-- granted to anyone else.
-- ---------------------------------------------------------------------
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
    'enter_marks', 'message_parents'
  ];
$$;

create or replace function public.locked_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['manage_institution_settings', 'manage_license', 'manage_staff'];
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
                                  'set_homework_retention', 'manage_programmes', 'view_reports', 'message_parents']
    when 'class_teacher' then array['record_attendance', 'create_assignments', 'enter_marks', 'view_reports', 'message_parents']
    when 'subject_teacher' then array['record_attendance', 'create_assignments', 'enter_marks']
    else array[]::text[]
  end;
$$;

create table if not exists public.institution_role_permissions (
  institution_id uuid not null references public.institutions (id) on delete cascade,
  role           text not null check (role in ('coordinator', 'class_teacher', 'subject_teacher')),
  permission     text not null,
  allowed        boolean not null,
  updated_at     timestamptz not null default now(),
  primary key (institution_id, role, permission),
  check (permission = any (public.all_permissions()) and not (permission = any (public.locked_permissions())))
);

create or replace function public.has_inst_perm_for(p_user uuid, p_inst uuid, p_perm text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role_for(p_user, p_inst);
  o boolean;
begin
  if r is null then
    return false;
  end if;
  if r in ('principal', 'director') then
    return p_perm = any (public.all_permissions());
  end if;
  if p_perm = any (public.locked_permissions()) then
    return false;
  end if;
  select allowed into o from public.institution_role_permissions
  where institution_id = p_inst and role = r and permission = p_perm;
  if found then
    return o;
  end if;
  return p_perm = any (public.default_role_permissions(r));
end;
$$;
revoke execute on function public.has_inst_perm_for(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.has_inst_perm(p_inst uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_inst_perm_for(auth.uid(), p_inst, p_perm);
$$;
revoke execute on function public.has_inst_perm(uuid, text) from public, anon;
grant execute on function public.has_inst_perm(uuid, text) to authenticated;

create or replace function public.my_permissions(p_inst uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p order by p), array[]::text[])
  from unnest(public.all_permissions()) p
  where public.has_inst_perm(p_inst, p);
$$;
revoke execute on function public.my_permissions(uuid) from public, anon;
grant execute on function public.my_permissions(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Invitations. token_hash = SHA-256 of a random one-time token that is only
-- ever emailed to the invitee; it is never readable by any client.
-- ---------------------------------------------------------------------
create table if not exists public.institution_invitations (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  email            text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  role             text not null check (role in ('principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher', 'student')),
  display_name     text not null check (char_length(btrim(display_name)) between 1 and 80),
  external_id      text check (external_id is null or char_length(btrim(external_id)) between 1 and 40),
  token_hash       text unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at       timestamptz not null,
  invited_by       uuid references auth.users (id) on delete set null,
  send_count       integer not null default 0,
  last_sent_at     timestamptz,
  accepted_at      timestamptz,
  accepted_user_id uuid references auth.users (id) on delete set null,
  membership_id    uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists invitations_pending_idx on public.institution_invitations (institution_id, email) where status = 'pending';
create index if not exists invitations_inst_idx on public.institution_invitations (institution_id, status, created_at desc);

-- ---------------------------------------------------------------------
-- Academic structure
-- ---------------------------------------------------------------------
create table if not exists public.academic_years (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 40),
  starts_on      date not null,
  ends_on        date not null,
  is_current     boolean not null default false,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_on > starts_on and ends_on - starts_on <= 800),
  unique (id, institution_id)
);
create unique index if not exists academic_years_current_idx on public.academic_years (institution_id) where is_current;

create table if not exists public.terms (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  academic_year_id uuid not null,
  name             text not null check (char_length(btrim(name)) between 1 and 40),
  starts_on        date not null,
  ends_on          date not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_on > starts_on),
  unique (id, institution_id),
  foreign key (academic_year_id, institution_id) references public.academic_years (id, institution_id) on delete cascade
);

create table if not exists public.subjects (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  code           text check (code is null or char_length(btrim(code)) between 1 and 20),
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, institution_id)
);
create unique index if not exists subjects_name_idx on public.subjects (institution_id, lower(name));

create table if not exists public.classes (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  academic_year_id uuid,
  grade            text not null check (char_length(btrim(grade)) between 1 and 30),
  section          text check (section is null or char_length(btrim(section)) between 1 and 20),
  name             text not null check (char_length(btrim(name)) between 1 and 60),
  class_teacher_id uuid,
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, institution_id),
  foreign key (academic_year_id, institution_id) references public.academic_years (id, institution_id),
  foreign key (class_teacher_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists classes_inst_idx on public.classes (institution_id, grade);

create table if not exists public.class_enrollments (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  class_id       uuid not null,
  student_id     uuid not null,
  roll_no        text check (roll_no is null or char_length(btrim(roll_no)) between 1 and 20),
  created_at     timestamptz not null default now(),
  unique (class_id, student_id),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade,
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists enrollments_student_idx on public.class_enrollments (student_id);

create table if not exists public.teaching_assignments (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  class_id       uuid not null,
  subject_id     uuid not null,
  teacher_id     uuid not null,
  created_at     timestamptz not null default now(),
  unique (class_id, subject_id, teacher_id),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade,
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id) on delete cascade,
  foreign key (teacher_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists teaching_teacher_idx on public.teaching_assignments (teacher_id);

-- Grades a coordinator oversees; '*' = every grade.
create table if not exists public.coordinator_scopes (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  coordinator_id uuid not null,
  grade          text not null check (char_length(btrim(grade)) between 1 and 30),
  created_at     timestamptz not null default now(),
  unique (coordinator_id, grade),
  foreign key (coordinator_id, institution_id) references public.institution_memberships (id, institution_id) on delete cascade
);

-- Role checks for people referenced by the academic structure.
create or replace function public.check_member_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text;
begin
  if tg_table_name = 'classes' then
    if new.class_teacher_id is not null then
      select role into r from public.institution_memberships where id = new.class_teacher_id and status = 'active';
      if r is null or not public.is_staff_role(r) or r in ('principal', 'director') then
        raise exception 'The class teacher must be an active teacher or coordinator.';
      end if;
    end if;
  elsif tg_table_name = 'class_enrollments' then
    select role into r from public.institution_memberships where id = new.student_id;
    if r is distinct from 'student' then
      raise exception 'Only students can be enrolled in a class.';
    end if;
  elsif tg_table_name = 'teaching_assignments' then
    select role into r from public.institution_memberships where id = new.teacher_id and status = 'active';
    if r is null or not public.is_staff_role(r) then
      raise exception 'Subjects can only be assigned to active staff.';
    end if;
  elsif tg_table_name = 'coordinator_scopes' then
    select role into r from public.institution_memberships where id = new.coordinator_id;
    if r is distinct from 'coordinator' then
      raise exception 'Grade scopes apply to coordinators only.';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Scope helpers
-- ---------------------------------------------------------------------
create or replace function public.in_coordinator_scope(p_inst uuid, p_grade text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.coordinator_scopes s
    where s.institution_id = p_inst and s.coordinator_id = public.my_membership_id(p_inst)
      and (s.grade = '*' or lower(s.grade) = lower(btrim(p_grade)))
  );
$$;
revoke execute on function public.in_coordinator_scope(uuid, text) from public, anon;
grant execute on function public.in_coordinator_scope(uuid, text) to authenticated;

-- Can the caller see this class and its academic data?
create or replace function public.can_view_class(p_class uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.classes;
  r text;
  me uuid;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null then
    return false;
  end if;
  r := public.inst_role(c.institution_id);
  if r is null then
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
  if exists (select 1 from public.teaching_assignments t where t.class_id = c.id and t.teacher_id = me) then
    return true;
  end if;
  if r = 'student' and exists (select 1 from public.class_enrollments e where e.class_id = c.id and e.student_id = me) then
    return true;
  end if;
  return false;
end;
$$;
revoke execute on function public.can_view_class(uuid) from public, anon;
grant execute on function public.can_view_class(uuid) to authenticated;

-- Can the caller change this class (teacher, enrolment, subjects)?
create or replace function public.can_manage_class(p_class uuid)
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
  if c.id is null or not public.has_inst_perm(c.institution_id, 'manage_classes') then
    return false;
  end if;
  r := public.inst_role(c.institution_id);
  if r in ('principal', 'director') then
    return true;
  end if;
  if r = 'coordinator' then
    return public.in_coordinator_scope(c.institution_id, c.grade);
  end if;
  return c.class_teacher_id = public.my_membership_id(c.institution_id);
end;
$$;
revoke execute on function public.can_manage_class(uuid) from public, anon;
grant execute on function public.can_manage_class(uuid) to authenticated;

create or replace function public.can_manage_grade(p_inst uuid, p_grade text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_inst_perm(p_inst, 'manage_classes')
     and (public.inst_role(p_inst) in ('principal', 'director') or public.in_coordinator_scope(p_inst, p_grade));
$$;
revoke execute on function public.can_manage_grade(uuid, text) from public, anon;
grant execute on function public.can_manage_grade(uuid, text) to authenticated;

-- Who can see a membership row?
create or replace function public.can_view_membership(p_inst uuid, p_id uuid, p_role text, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text;
  me uuid;
begin
  if p_user is not null and p_user = auth.uid() then
    return true;
  end if;
  r := public.inst_role(p_inst);
  if r is null then
    -- The platform owner can see who runs each institution, nothing more.
    return p_role in ('principal', 'director') and public.is_platform_admin();
  end if;
  if r in ('principal', 'director') or public.is_staff_role(p_role) and r <> 'parent' then
    return true;
  end if;
  if p_role <> 'student' or not public.is_staff_role(r) then
    return false;
  end if;
  if public.has_inst_perm(p_inst, 'manage_students') or public.has_inst_perm(p_inst, 'view_all_classes') then
    return r <> 'coordinator'
        or not exists (select 1 from public.class_enrollments e where e.student_id = p_id)
        or exists (select 1 from public.class_enrollments e join public.classes c on c.id = e.class_id
                   where e.student_id = p_id and public.in_coordinator_scope(p_inst, c.grade))
        or public.has_inst_perm(p_inst, 'view_all_classes');
  end if;
  me := public.my_membership_id(p_inst);
  return exists (
    select 1 from public.class_enrollments e
    join public.classes c on c.id = e.class_id
    where e.student_id = p_id
      and (c.class_teacher_id = me
           or exists (select 1 from public.teaching_assignments t where t.class_id = c.id and t.teacher_id = me)
           or (r = 'coordinator' and public.in_coordinator_scope(p_inst, c.grade)))
  );
end;
$$;
revoke execute on function public.can_view_membership(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.can_view_membership(uuid, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Academic calendar
-- ---------------------------------------------------------------------
create table if not exists public.calendar_events (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  kind           text not null check (kind in ('exam', 'holiday', 'event', 'workshop', 'programme', 'ptm', 'other')),
  title          text not null check (char_length(btrim(title)) between 1 and 120),
  description    text check (description is null or char_length(description) <= 2000),
  starts_on      date not null,
  ends_on        date not null,
  start_time     time,
  end_time       time,
  class_id       uuid,
  grade          text check (grade is null or char_length(btrim(grade)) between 1 and 30),
  subject_id     uuid,
  status         text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_on >= starts_on and ends_on - starts_on <= 366),
  check (start_time is null or end_time is null or end_time > start_time),
  check (class_id is null or grade is null),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade,
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id)
);
create index if not exists calendar_inst_dates_idx on public.calendar_events (institution_id, starts_on, ends_on);

-- Does an event apply to a class? (institution-wide, the class's grade, or the class itself)
create or replace function public.event_applies(p_event_class uuid, p_event_grade text, p_class uuid, p_class_grade text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_event_class is null and p_event_grade is null)
      or p_event_class = p_class
      or (p_event_class is null and lower(p_event_grade) = lower(p_class_grade));
$$;

create or replace function public.can_view_event(p_inst uuid, p_class uuid, p_grade text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
begin
  if r is null then
    return false;
  end if;
  if (p_class is null and p_grade is null) or public.is_staff_role(r) then
    return true;
  end if;
  if p_class is not null then
    return public.can_view_class(p_class);
  end if;
  return exists (
    select 1 from public.class_enrollments e join public.classes c on c.id = e.class_id
    where e.student_id = public.my_membership_id(p_inst) and lower(c.grade) = lower(p_grade)
  );
end;
$$;
revoke execute on function public.can_view_event(uuid, uuid, text) from public, anon;
grant execute on function public.can_view_event(uuid, uuid, text) to authenticated;

create or replace function public.can_manage_event(p_inst uuid, p_class uuid, p_grade text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  g text;
begin
  if not public.has_inst_perm(p_inst, 'manage_calendar') then
    return false;
  end if;
  if r in ('principal', 'director') then
    return true;
  end if;
  if p_class is not null then
    select grade into g from public.classes where id = p_class and institution_id = p_inst;
    return g is not null and (public.can_manage_class(p_class) or (r = 'coordinator' and public.in_coordinator_scope(p_inst, g)));
  end if;
  if p_grade is not null then
    return r = 'coordinator' and public.in_coordinator_scope(p_inst, p_grade);
  end if;
  -- institution-wide events: heads, or coordinators who oversee every grade
  return r = 'coordinator'
     and exists (select 1 from public.coordinator_scopes s where s.coordinator_id = public.my_membership_id(p_inst) and s.grade = '*');
end;
$$;
revoke execute on function public.can_manage_event(uuid, uuid, text) from public, anon;
grant execute on function public.can_manage_event(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Assignments (homework, classwork, projects). Phase 1 stores deadlines for
-- the cross-subject calendar; file submissions arrive in Phase 2.
-- Submission window: start before deadline, at most one calendar month.
-- ---------------------------------------------------------------------
create table if not exists public.assignments (
  id                    uuid primary key default gen_random_uuid(),
  institution_id        uuid not null references public.institutions (id) on delete cascade,
  class_id              uuid not null,
  subject_id            uuid not null,
  teacher_id            uuid not null,
  title                 text not null check (char_length(btrim(title)) between 1 and 120),
  description           text check (description is null or char_length(description) <= 4000),
  kind                  text not null default 'homework' check (kind in ('homework', 'classwork', 'project', 'assessment')),
  opens_at              timestamptz not null,
  due_at                timestamptz not null,
  status                text not null default 'published' check (status in ('draft', 'published', 'closed', 'cancelled')),
  allowed_types         text[] not null default array['pdf', 'jpg', 'png'],
  max_file_mb           smallint not null default 4 check (max_file_mb between 1 and 4),
  late_policy           text not null default 'accept_marked_late' check (late_policy in ('reject', 'accept_marked_late')),
  review_retention_days smallint not null default 7 check (review_retention_days between 0 and 14),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (due_at > opens_at),
  check (due_at <= opens_at + interval '1 month'),
  check (cardinality(allowed_types) >= 1 and allowed_types <@ array['pdf', 'jpg', 'png']),
  unique (id, institution_id),
  foreign key (class_id, institution_id) references public.classes (id, institution_id),
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id),
  foreign key (teacher_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists assignments_class_due_idx on public.assignments (class_id, due_at);
create index if not exists assignments_inst_due_idx on public.assignments (institution_id, due_at);

create or replace function public.teaches(p_class uuid, p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.teaching_assignments t
    join public.classes c on c.id = t.class_id
    where t.class_id = p_class and t.subject_id = p_subject and t.teacher_id = public.my_membership_id(c.institution_id)
  );
$$;
revoke execute on function public.teaches(uuid, uuid) from public, anon;
grant execute on function public.teaches(uuid, uuid) to authenticated;

-- Retention interval comes from the institution (set by coordinators); teachers can't change it.
create or replace function public.assignment_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.review_retention_days := (public.institution_settings(new.institution_id) ->> 'homework_retention_days')::smallint;
    new.created_by := coalesce(public.current_actor(), new.created_by);
  elsif new.review_retention_days is distinct from old.review_retention_days
        and not public.has_inst_perm(new.institution_id, 'set_homework_retention') then
    raise exception 'Only coordinators can change the review/retention interval.';
  end if;
  if tg_op = 'UPDATE' and (new.class_id <> old.class_id or new.teacher_id <> old.teacher_id) then
    raise exception 'Create a new assignment to change its class or teacher.';
  end if;
  return new;
end;
$$;

create or replace function public.can_edit_assignment(p_inst uuid, p_class uuid, p_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_teacher = public.my_membership_id(p_inst)
      or (public.has_inst_perm(p_inst, 'manage_classes') and public.can_manage_class(p_class)
          and public.inst_role(p_inst) in ('principal', 'director', 'coordinator'));
$$;
revoke execute on function public.can_edit_assignment(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_edit_assignment(uuid, uuid, uuid) to authenticated;

-- Deadline change proposals (from coordinators, teachers or the AI planner);
-- applied only when an authorized person approves.
create table if not exists public.deadline_change_requests (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  assignment_id    uuid not null,
  proposed_opens_at timestamptz,
  proposed_due_at  timestamptz not null,
  reason           text not null check (char_length(btrim(reason)) between 3 and 500),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by     uuid default auth.uid() references auth.users (id) on delete set null,
  decided_by       uuid references auth.users (id) on delete set null,
  decision_note    text check (decision_note is null or char_length(decision_note) <= 500),
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (assignment_id, institution_id) references public.assignments (id, institution_id) on delete cascade
);
create index if not exists deadline_requests_inst_idx on public.deadline_change_requests (institution_id, status);

-- ---------------------------------------------------------------------
-- Triggers: updated_at, institution pinning, role checks, audit
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['institution_memberships', 'institution_invitations', 'academic_years', 'terms', 'subjects',
                           'classes', 'calendar_events', 'assignments', 'deadline_change_requests', 'institution_role_permissions'] loop
    execute format('drop trigger if exists %1$s_updated_at on public.%1$I', t);
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['institution_memberships', 'institution_invitations', 'institution_email_allowlist', 'academic_years',
                           'terms', 'subjects', 'classes', 'class_enrollments', 'teaching_assignments', 'coordinator_scopes',
                           'calendar_events', 'assignments', 'deadline_change_requests', 'institution_role_permissions'] loop
    execute format('drop trigger if exists %1$s_keep_inst on public.%1$I', t);
    execute format('create trigger %1$s_keep_inst before update on public.%1$I for each row execute function public.keep_institution_id()', t);
  end loop;
  foreach t in array array['classes', 'class_enrollments', 'teaching_assignments', 'coordinator_scopes'] loop
    execute format('drop trigger if exists %1$s_roles on public.%1$I', t);
    execute format('create trigger %1$s_roles before insert or update on public.%1$I for each row execute function public.check_member_roles()', t);
  end loop;
  foreach t in array array['institutions', 'institution_memberships', 'institution_invitations', 'institution_email_allowlist',
                           'institution_role_permissions', 'academic_years', 'terms', 'subjects', 'classes', 'class_enrollments',
                           'teaching_assignments', 'coordinator_scopes', 'calendar_events', 'assignments',
                           'deadline_change_requests', 'platform_admins'] loop
    execute format('drop trigger if exists %1$s_audit on public.%1$I', t);
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$I for each row execute function public.audit_row_change()', t);
  end loop;
end $$;

drop trigger if exists assignments_rules on public.assignments;
create trigger assignments_rules before insert or update on public.assignments
  for each row execute function public.assignment_rules();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.institutions                 enable row level security;
alter table public.institution_email_allowlist  enable row level security;
alter table public.institution_memberships      enable row level security;
alter table public.institution_role_permissions enable row level security;
alter table public.institution_invitations      enable row level security;
alter table public.academic_years               enable row level security;
alter table public.terms                        enable row level security;
alter table public.subjects                     enable row level security;
alter table public.classes                      enable row level security;
alter table public.class_enrollments            enable row level security;
alter table public.teaching_assignments         enable row level security;
alter table public.coordinator_scopes           enable row level security;
alter table public.calendar_events              enable row level security;
alter table public.assignments                  enable row level security;
alter table public.deadline_change_requests     enable row level security;

revoke all on public.institutions, public.institution_email_allowlist, public.institution_memberships,
  public.institution_role_permissions, public.institution_invitations, public.academic_years, public.terms,
  public.subjects, public.classes, public.class_enrollments, public.teaching_assignments, public.coordinator_scopes,
  public.calendar_events, public.assignments, public.deadline_change_requests
  from anon, authenticated;

-- institutions: members read their own; heads edit branding/settings; status only via platform functions.
drop policy if exists "institutions: members read" on public.institutions;
create policy "institutions: members read" on public.institutions for select to authenticated
  using (public.inst_role(id) is not null or public.is_platform_admin());
drop policy if exists "institutions: heads update" on public.institutions;
create policy "institutions: heads update" on public.institutions for update to authenticated
  using (public.has_inst_perm(id, 'manage_institution_settings'))
  with check (public.has_inst_perm(id, 'manage_institution_settings'));
grant select on public.institutions to authenticated;
grant update (name, short_name, timezone, logo_url, brand_color, settings) on public.institutions to authenticated;

-- allowlist: platform owner manages; heads can read their own.
drop policy if exists "allowlist: read" on public.institution_email_allowlist;
create policy "allowlist: read" on public.institution_email_allowlist for select to authenticated
  using (public.is_platform_admin() or public.has_inst_perm(institution_id, 'manage_staff'));
drop policy if exists "allowlist: platform insert" on public.institution_email_allowlist;
create policy "allowlist: platform insert" on public.institution_email_allowlist for insert to authenticated
  with check (public.is_platform_admin());
drop policy if exists "allowlist: platform update" on public.institution_email_allowlist;
create policy "allowlist: platform update" on public.institution_email_allowlist for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select on public.institution_email_allowlist to authenticated;
grant insert (institution_id, kind, value, note) on public.institution_email_allowlist to authenticated;
grant update (status, note) on public.institution_email_allowlist to authenticated;

-- memberships: read per can_view_membership; all changes through functions.
drop policy if exists "memberships: read" on public.institution_memberships;
create policy "memberships: read" on public.institution_memberships for select to authenticated
  using (public.can_view_membership(institution_id, id, role, user_id));
grant select on public.institution_memberships to authenticated;

-- permissions overrides: staff read, heads write.
drop policy if exists "role perms: read" on public.institution_role_permissions;
create policy "role perms: read" on public.institution_role_permissions for select to authenticated
  using (public.inst_role(institution_id) is not null and public.is_staff_role(public.inst_role(institution_id)));
drop policy if exists "role perms: heads write" on public.institution_role_permissions;
create policy "role perms: heads write" on public.institution_role_permissions for all to authenticated
  using (public.has_inst_perm(institution_id, 'manage_institution_settings'))
  with check (public.has_inst_perm(institution_id, 'manage_institution_settings'));
grant select, insert, update, delete on public.institution_role_permissions to authenticated;

-- invitations: no token hash for anyone; created and resent by the server function.
drop policy if exists "invitations: read" on public.institution_invitations;
create policy "invitations: read" on public.institution_invitations for select to authenticated
  using (public.has_inst_perm(institution_id, 'manage_staff')
         or (role = 'student' and public.has_inst_perm(institution_id, 'manage_students'))
         or (role in ('principal', 'director') and public.is_platform_admin()));
grant select (id, institution_id, email, role, display_name, external_id, status, expires_at, invited_by, send_count,
              last_sent_at, accepted_at, membership_id, created_at, updated_at)
  on public.institution_invitations to authenticated;

-- academic years and terms: members read, heads write.
do $$
declare t text;
begin
  foreach t in array array['academic_years', 'terms'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.inst_role(institution_id) is not null)', t);
    execute format('drop policy if exists "heads write" on public.%I', t);
    execute format('create policy "heads write" on public.%I for all to authenticated
      using (public.has_inst_perm(institution_id, ''manage_institution_settings''))
      with check (public.has_inst_perm(institution_id, ''manage_institution_settings''))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- subjects: members read, manage_classes writes (no deletes: archive instead).
drop policy if exists "read" on public.subjects;
create policy "read" on public.subjects for select to authenticated using (public.inst_role(institution_id) is not null);
drop policy if exists "insert" on public.subjects;
create policy "insert" on public.subjects for insert to authenticated with check (public.has_inst_perm(institution_id, 'manage_classes'));
drop policy if exists "update" on public.subjects;
create policy "update" on public.subjects for update to authenticated
  using (public.has_inst_perm(institution_id, 'manage_classes')) with check (public.has_inst_perm(institution_id, 'manage_classes'));
grant select on public.subjects to authenticated;
grant insert (institution_id, name, code) on public.subjects to authenticated;
grant update (name, code, archived) on public.subjects to authenticated;

-- classes
drop policy if exists "read" on public.classes;
create policy "read" on public.classes for select to authenticated
  using (public.can_view_class(id) or public.can_manage_grade(institution_id, grade));
drop policy if exists "insert" on public.classes;
create policy "insert" on public.classes for insert to authenticated with check (public.can_manage_grade(institution_id, grade));
drop policy if exists "update" on public.classes;
create policy "update" on public.classes for update to authenticated
  using (public.can_manage_class(id)) with check (public.can_manage_grade(institution_id, grade) or public.can_manage_class(id));
grant select on public.classes to authenticated;
grant insert (institution_id, academic_year_id, grade, section, name, class_teacher_id) on public.classes to authenticated;
grant update (academic_year_id, grade, section, name, class_teacher_id, archived) on public.classes to authenticated;

-- enrolments and teaching assignments: managed by those who manage the class.
do $$
declare t text;
begin
  foreach t in array array['class_enrollments', 'teaching_assignments'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "manage" on public.%I', t);
    execute format('create policy "manage" on public.%I for all to authenticated
      using (public.can_manage_class(class_id)) with check (public.can_manage_class(class_id))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
create policy "read" on public.class_enrollments for select to authenticated
  using (public.can_view_class(class_id) and (public.is_staff_role(public.inst_role(institution_id))
         or student_id = public.my_membership_id(institution_id)));
create policy "read" on public.teaching_assignments for select to authenticated
  using (public.can_view_class(class_id));

-- coordinator scopes: staff read, heads manage.
drop policy if exists "read" on public.coordinator_scopes;
create policy "read" on public.coordinator_scopes for select to authenticated
  using (public.is_staff_role(public.inst_role(institution_id)));
drop policy if exists "heads manage" on public.coordinator_scopes;
create policy "heads manage" on public.coordinator_scopes for all to authenticated
  using (public.has_inst_perm(institution_id, 'manage_staff')) with check (public.has_inst_perm(institution_id, 'manage_staff'));
grant select, insert, delete on public.coordinator_scopes to authenticated;

-- calendar events
drop policy if exists "read" on public.calendar_events;
create policy "read" on public.calendar_events for select to authenticated
  using (public.can_view_event(institution_id, class_id, grade));
drop policy if exists "insert" on public.calendar_events;
create policy "insert" on public.calendar_events for insert to authenticated
  with check (public.can_manage_event(institution_id, class_id, grade) and created_by = (select auth.uid()));
drop policy if exists "update" on public.calendar_events;
create policy "update" on public.calendar_events for update to authenticated
  using (public.can_manage_event(institution_id, class_id, grade))
  with check (public.can_manage_event(institution_id, class_id, grade));
drop policy if exists "delete" on public.calendar_events;
create policy "delete" on public.calendar_events for delete to authenticated
  using (public.can_manage_event(institution_id, class_id, grade));
grant select, delete on public.calendar_events to authenticated;
grant insert (institution_id, kind, title, description, starts_on, ends_on, start_time, end_time, class_id, grade, subject_id, status, created_by)
  on public.calendar_events to authenticated;
grant update (kind, title, description, starts_on, ends_on, start_time, end_time, class_id, grade, subject_id, status)
  on public.calendar_events to authenticated;

-- assignments: students see published work for their classes; teachers create for subjects they teach.
drop policy if exists "read" on public.assignments;
create policy "read" on public.assignments for select to authenticated
  using (public.can_view_class(class_id)
         and (status <> 'draft' or public.can_edit_assignment(institution_id, class_id, teacher_id)));
drop policy if exists "insert" on public.assignments;
create policy "insert" on public.assignments for insert to authenticated
  with check (public.has_inst_perm(institution_id, 'create_assignments')
              and teacher_id = public.my_membership_id(institution_id)
              and public.teaches(class_id, subject_id));
drop policy if exists "update" on public.assignments;
create policy "update" on public.assignments for update to authenticated
  using (public.can_edit_assignment(institution_id, class_id, teacher_id))
  with check (public.can_edit_assignment(institution_id, class_id, teacher_id));
grant select on public.assignments to authenticated;
grant insert (institution_id, class_id, subject_id, teacher_id, title, description, kind, opens_at, due_at, status,
              allowed_types, max_file_mb, late_policy)
  on public.assignments to authenticated;
grant update (subject_id, title, description, kind, opens_at, due_at, status, allowed_types, max_file_mb, late_policy, review_retention_days)
  on public.assignments to authenticated;

-- deadline change requests: staff who can see the class propose; decided via decide_deadline_change().
drop policy if exists "read" on public.deadline_change_requests;
create policy "read" on public.deadline_change_requests for select to authenticated
  using (public.is_staff_role(public.inst_role(institution_id))
         and exists (select 1 from public.assignments a where a.id = assignment_id and public.can_view_class(a.class_id)));
drop policy if exists "insert" on public.deadline_change_requests;
create policy "insert" on public.deadline_change_requests for insert to authenticated
  with check (requested_by = (select auth.uid()) and status = 'pending'
              and public.is_staff_role(public.inst_role(institution_id))
              and exists (select 1 from public.assignments a where a.id = assignment_id and public.can_view_class(a.class_id)));
drop policy if exists "withdraw" on public.deadline_change_requests;
create policy "withdraw" on public.deadline_change_requests for update to authenticated
  using (requested_by = (select auth.uid()) and status = 'pending')
  with check (requested_by = (select auth.uid()) and status = 'withdrawn');
grant select on public.deadline_change_requests to authenticated;
grant insert (institution_id, assignment_id, proposed_opens_at, proposed_due_at, reason, requested_by) on public.deadline_change_requests to authenticated;
grant update (status) on public.deadline_change_requests to authenticated;

-- audit log: heads (or anyone granted view_audit) read their institution's;
-- the platform owner reads platform-level records. Nobody writes directly.
drop policy if exists "audit: read" on public.audit_log;
create policy "audit: read" on public.audit_log for select to authenticated
  using ((institution_id is not null and public.has_inst_perm(institution_id, 'view_audit'))
         or (public.is_platform_admin() and record_type in ('institutions', 'institution_email_allowlist', 'platform_admins')));
grant select on public.audit_log to authenticated;

-- ---------------------------------------------------------------------
-- Sign-up rules: usernames for individuals; institutional accounts only
-- with the one-time activation token from an invitation email. The token is
-- checked against the stored SHA-256 hash and removed from the account's
-- metadata before the row is written; only the invitation id is passed on
-- (transaction-local) to handle_new_user().
-- ---------------------------------------------------------------------
create or replace function public.before_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok text := coalesce(new.raw_user_meta_data ->> 'activation_token', '');
  inv_id uuid;
begin
  perform set_config('habitflow.invitation_id', '', true);
  if lower(new.email) like '%@habitflow.local' then
    return new;
  end if;
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'activation_token';
  if length(tok) < 32 then
    raise exception 'Institutional accounts can only be created from an invitation.';
  end if;
  select id into inv_id from public.institution_invitations
   where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex')
     and status = 'pending' and expires_at > now() and email = lower(new.email);
  if inv_id is null then
    raise exception 'This invitation is invalid or has expired.';
  end if;
  perform set_config('habitflow.invitation_id', inv_id::text, true);
  return new;
end;
$$;
drop trigger if exists before_auth_user_created on auth.users;
create trigger before_auth_user_created before insert on auth.users
  for each row execute function public.before_new_user();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  inv_text text := coalesce(current_setting('habitflow.invitation_id', true), '');
  inv public.institution_invitations;
  mid uuid;
begin
  if lower(new.email) like '%@habitflow.local' then
    if uname !~ '^[a-z0-9_.-]{3,24}$' then
      raise exception 'Invalid username';
    end if;
    if lower(new.email) <> uname || '@habitflow.local' then
      raise exception 'Username does not match login';
    end if;
    insert into public.profiles (id, username) values (new.id, uname);
    return new;
  end if;

  if inv_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Institutional accounts can only be created from an invitation.';
  end if;
  select * into inv from public.institution_invitations where id = inv_text::uuid for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at < now() or inv.email <> lower(new.email) then
    raise exception 'This invitation is invalid or has expired.';
  end if;

  perform set_config('habitflow.actor', new.id::text, true);
  insert into public.profiles (id, username, account_type, display_name)
  values (new.id, 'i' || substr(replace(new.id::text, '-', ''), 1, 15), 'institutional', inv.display_name);
  insert into public.institution_memberships (institution_id, user_id, role, display_name, external_id)
  values (inv.institution_id, new.id, inv.role, inv.display_name, inv.external_id)
  returning id into mid;
  update public.institution_invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = new.id, membership_id = mid, token_hash = null
   where id = inv.id;
  return new;
end;
$$;

-- Login addresses don't change through the Auth API: usernames change with
-- change_username(), institutional addresses only by the platform.
create or replace function public.guard_auth_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.profiles;
begin
  if new.email is not distinct from old.email or current_setting('habitflow.allow_email_change', true) = 'on' then
    return new;
  end if;
  select * into p from public.profiles where id = new.id;
  if p.id is null then
    return new;
  end if;
  if p.account_type = 'individual' and lower(new.email) = p.username || '@habitflow.local' then
    return new;
  end if;
  raise exception 'The login address of this account can''t be changed.';
end;
$$;
drop trigger if exists guard_email_change on auth.users;
create trigger guard_email_change before update of email on auth.users
  for each row execute function public.guard_auth_email_change();

-- Membership rows are only created for institutional accounts.
create or replace function public.check_membership_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is not null and tg_op = 'INSERT'
     and not exists (select 1 from public.profiles where id = new.user_id and account_type = 'institutional') then
    raise exception 'Only institutional accounts can join an institution.';
  end if;
  return new;
end;
$$;
drop trigger if exists memberships_account on public.institution_memberships;
create trigger memberships_account before insert on public.institution_memberships
  for each row execute function public.check_membership_account();

-- ---------------------------------------------------------------------
-- Invitations (called by the institution-invite server function, which
-- verifies the caller's session and passes p_actor).
-- ---------------------------------------------------------------------
create or replace function public.can_invite_role(p_actor uuid, p_inst uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_role in ('principal', 'director') then public.is_platform_admin_user(p_actor)
    when p_role in ('coordinator', 'class_teacher', 'subject_teacher') then
      public.is_platform_admin_user(p_actor) or public.has_inst_perm_for(p_actor, p_inst, 'manage_staff')
    when p_role = 'student' then
      public.is_platform_admin_user(p_actor) or public.has_inst_perm_for(p_actor, p_inst, 'manage_students')
    else false
  end;
$$;
revoke execute on function public.can_invite_role(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.create_invitation(
  p_actor uuid, p_inst uuid, p_email text, p_role text, p_name text, p_external_id text, p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  em text := lower(btrim(coalesce(p_email, '')));
  inst public.institutions;
  inv_id uuid;
  exp timestamptz := now() + interval '7 days';
begin
  perform set_config('habitflow.actor', p_actor::text, true);
  select * into inst from public.institutions where id = p_inst;
  if inst.id is null then
    raise exception 'Institution not found.';
  end if;
  if inst.status <> 'active' then
    raise exception 'This institution is not active.';
  end if;
  if em !~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(em) > 254 or em like '%@habitflow.local' then
    raise exception 'Enter a valid email address.';
  end if;
  if p_role not in ('principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher', 'student') then
    raise exception 'Choose a valid role.';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Enter the person''s name (up to 80 characters).';
  end if;
  if not public.can_invite_role(p_actor, p_inst, p_role) then
    raise exception 'You are not allowed to invite someone with this role.';
  end if;
  if not public.email_allowlisted(p_inst, em, p_role in ('principal', 'director')) then
    if p_role in ('principal', 'director') then
      raise exception 'Principal and director invitations need this exact address on the approved list (a matching domain is not enough).';
    end if;
    raise exception 'This email address isn''t on the institution''s approved list.';
  end if;
  if exists (
    select 1 from public.institution_memberships m join auth.users u on u.id = m.user_id
    where m.institution_id = p_inst and lower(u.email) = em
  ) then
    raise exception 'This person already has an account at this institution.';
  end if;

  update public.institution_invitations set status = 'revoked', token_hash = null
   where institution_id = p_inst and email = em and status = 'pending';
  insert into public.institution_invitations
    (institution_id, email, role, display_name, external_id, token_hash, expires_at, invited_by, send_count, last_sent_at)
  values (p_inst, em, p_role, btrim(p_name), nullif(btrim(coalesce(p_external_id, '')), ''), p_token_hash, exp, p_actor, 1, now())
  returning id into inv_id;
  return jsonb_build_object('id', inv_id, 'email', em, 'expires_at', exp, 'institution', inst.name, 'role', p_role);
end;
$$;
revoke execute on function public.create_invitation(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, uuid, text, text, text, text, text) to service_role;

-- New link for a pending (or expired) invitation; the old link stops working.
create or replace function public.rotate_invitation(p_actor uuid, p_invitation uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.institution_invitations;
  inst_name text;
  exp timestamptz := now() + interval '7 days';
begin
  perform set_config('habitflow.actor', p_actor::text, true);
  select * into inv from public.institution_invitations where id = p_invitation for update;
  if inv.id is null or not public.can_invite_role(p_actor, inv.institution_id, inv.role) then
    raise exception 'Invitation not found.';
  end if;
  if inv.status <> 'pending' then
    raise exception 'This invitation has already been %.', inv.status;
  end if;
  if inv.last_sent_at > now() - interval '1 minute' then
    raise exception 'Please wait a minute before sending this invitation again.';
  end if;
  if inv.send_count >= 10 then
    raise exception 'This invitation has been sent too many times. Revoke it and invite again.';
  end if;
  update public.institution_invitations
     set token_hash = p_token_hash, expires_at = exp, send_count = send_count + 1, last_sent_at = now()
   where id = inv.id;
  select i.name into inst_name from public.institutions i where i.id = inv.institution_id;
  return jsonb_build_object('id', inv.id, 'email', inv.email, 'expires_at', exp, 'institution', inst_name, 'role', inv.role,
                            'display_name', inv.display_name);
end;
$$;
revoke execute on function public.rotate_invitation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rotate_invitation(uuid, uuid, text) to service_role;

create or replace function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.institution_invitations;
begin
  select * into inv from public.institution_invitations where id = p_invitation for update;
  if inv.id is null or not public.can_invite_role(auth.uid(), inv.institution_id, inv.role) then
    raise exception 'Invitation not found.';
  end if;
  if inv.status <> 'pending' then
    raise exception 'Only pending invitations can be revoked.';
  end if;
  update public.institution_invitations set status = 'revoked', token_hash = null where id = inv.id;
end;
$$;
revoke execute on function public.revoke_invitation(uuid) from public, anon;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- What the activation page shows for a link (server function only).
create or replace function public.invitation_preview(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id, 'email', i.email, 'role', i.role, 'display_name', i.display_name,
    'institution', s.name, 'expired', i.expires_at < now(), 'status', i.status,
    'account_exists', exists (select 1 from auth.users u where lower(u.email) = i.email)
  )
  from public.institution_invitations i join public.institutions s on s.id = i.institution_id
  where i.token_hash = p_token_hash and p_token_hash ~ '^[0-9a-f]{64}$';
$$;
revoke execute on function public.invitation_preview(text) from public, anon, authenticated;
grant execute on function public.invitation_preview(text) to service_role;

-- An existing institutional account accepts an invitation to another institution.
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  inv public.institution_invitations;
  mid uuid;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if p_token is null or length(p_token) < 32 then
    raise exception 'This invitation link is invalid.';
  end if;
  select * into inv from public.institution_invitations
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at < now() then
    raise exception 'This invitation link is invalid or has expired.';
  end if;
  if inv.email <> (select lower(email) from auth.users where id = me) then
    raise exception 'This invitation was sent to a different email address. Log in with that address.';
  end if;
  insert into public.institution_memberships (institution_id, user_id, role, display_name, external_id)
  values (inv.institution_id, me, inv.role, inv.display_name, inv.external_id)
  returning id into mid;
  update public.institution_invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = me, membership_id = mid, token_hash = null
   where id = inv.id;
  return jsonb_build_object('institution_id', inv.institution_id, 'membership_id', mid);
end;
$$;
revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Forgot password for institutional accounts (server function only).
create or replace function public.institutional_login_exists(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u join public.profiles p on p.id = u.id
    where lower(u.email) = lower(btrim(p_email)) and p.account_type = 'institutional'
  );
$$;
revoke execute on function public.institutional_login_exists(text) from public, anon, authenticated;
grant execute on function public.institutional_login_exists(text) to service_role;

-- ---------------------------------------------------------------------
-- Membership administration
-- ---------------------------------------------------------------------
create or replace function public.can_administer_member(p_inst uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_role in ('principal', 'director') then public.is_platform_admin()
    when p_role = 'student' then public.has_inst_perm(p_inst, 'manage_students')
    when p_role = 'parent' then public.has_inst_perm(p_inst, 'manage_students')
    else public.has_inst_perm(p_inst, 'manage_staff')
  end;
$$;
revoke execute on function public.can_administer_member(uuid, text) from public, anon;
grant execute on function public.can_administer_member(uuid, text) to authenticated;

-- Suspend, revoke or reactivate. Suspending or revoking signs the person out
-- everywhere; the database blocks their institutional data immediately.
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
    raise exception 'Member not found.';
  end if;
  if m.user_id = auth.uid() then
    raise exception 'You can''t change your own access.';
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

-- Edit name / ID / role. Staff roles can change among themselves; nobody
-- becomes a principal or director here (the platform owner invites heads).
create or replace function public.update_member(p_membership uuid, p_name text, p_external_id text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.institution_memberships;
  new_role text := coalesce(p_role, '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into m from public.institution_memberships where id = p_membership for update;
  if m.id is null or not public.can_administer_member(m.institution_id, m.role) then
    raise exception 'Member not found.';
  end if;
  if new_role = '' then
    new_role := m.role;
  end if;
  if new_role <> m.role then
    if m.user_id = auth.uid() then
      raise exception 'You can''t change your own role.';
    end if;
    if new_role not in ('coordinator', 'class_teacher', 'subject_teacher') or m.role not in ('coordinator', 'class_teacher', 'subject_teacher') then
      raise exception 'Roles can only change between coordinator, class teacher and subject teacher.';
    end if;
    if not public.has_inst_perm(m.institution_id, 'manage_staff') then
      raise exception 'You are not allowed to change roles.';
    end if;
    if m.role = 'coordinator' then
      delete from public.coordinator_scopes where coordinator_id = m.id;
    end if;
  end if;
  update public.institution_memberships
     set display_name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), display_name),
         external_id = nullif(btrim(coalesce(p_external_id, '')), ''),
         role = new_role
   where id = m.id;
end;
$$;
revoke execute on function public.update_member(uuid, text, text, text) from public, anon;
grant execute on function public.update_member(uuid, text, text, text) to authenticated;

-- Coordinators set the homework review/retention interval (max 14 days).
create or replace function public.set_homework_retention(p_inst uuid, p_days integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_inst_perm(p_inst, 'set_homework_retention') then
    raise exception 'You are not allowed to change the retention interval.';
  end if;
  if p_days is null or p_days not between 0 and 14 then
    raise exception 'The homework review/retention interval must be between 0 and 14 days.';
  end if;
  update public.institutions
     set settings = settings || jsonb_build_object('homework_retention_days', p_days)
   where id = p_inst;
end;
$$;
revoke execute on function public.set_homework_retention(uuid, integer) from public, anon;
grant execute on function public.set_homework_retention(uuid, integer) to authenticated;

-- Approve or reject a deadline change; approval applies it (same window rules).
create or replace function public.decide_deadline_change(p_request uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.deadline_change_requests;
  a public.assignments;
begin
  select * into r from public.deadline_change_requests where id = p_request for update;
  if r.id is null then
    raise exception 'Request not found.';
  end if;
  select * into a from public.assignments where id = r.assignment_id for update;
  -- approvers: heads and in-scope coordinators with the permission, or the assignment's own teacher
  if not ((public.has_inst_perm(r.institution_id, 'approve_deadline_changes') and public.can_view_class(a.class_id)
           and public.inst_role(r.institution_id) in ('principal', 'director', 'coordinator'))
          or a.teacher_id = public.my_membership_id(r.institution_id)) then
    raise exception 'You are not allowed to decide this request.';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request has already been %.', r.status;
  end if;
  perform set_config('habitflow.audit_reason', coalesce(r.reason, ''), true);
  if p_approve then
    update public.assignments
       set opens_at = coalesce(r.proposed_opens_at, opens_at), due_at = r.proposed_due_at
     where id = a.id;
  end if;
  update public.deadline_change_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = r.id;
end;
$$;
revoke execute on function public.decide_deadline_change(uuid, boolean, text) from public, anon;
grant execute on function public.decide_deadline_change(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Read models for dashboards
-- ---------------------------------------------------------------------
create or replace function public.my_institutions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'membership_id', m.id, 'institution_id', i.id, 'name', i.name, 'short_name', i.short_name, 'kind', i.kind,
    'logo_url', i.logo_url, 'brand_color', i.brand_color, 'timezone', i.timezone, 'role', m.role,
    'status', m.status, 'institution_status', i.status, 'display_name', m.display_name,
    'permissions', case when m.status = 'active' and i.status = 'active' then to_jsonb(public.my_permissions(i.id)) else '[]'::jsonb end
  ) order by i.name), '[]'::jsonb)
  from public.institution_memberships m
  join public.institutions i on i.id = m.institution_id
  where m.user_id = auth.uid();
$$;
revoke execute on function public.my_institutions() from public, anon;
grant execute on function public.my_institutions() to authenticated;

-- Cross-subject deadline calendar with conflict detection, built from the
-- actual assignments and calendar events the caller is allowed to see.
create or replace function public.deadline_calendar(
  p_inst uuid, p_from date, p_to date,
  p_class uuid default null, p_grade text default null, p_subject uuid default null, p_teacher uuid default null
)
returns table (
  day date, class_id uuid, class_name text, grade text,
  deadlines jsonb, exams jsonb, deadline_count integer, exam_count integer, week_deadlines integer,
  is_holiday boolean, holiday text, flags text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  per_day integer;
  per_week integer;
  s jsonb;
begin
  if public.inst_role(p_inst) is null then
    raise exception 'Not a member of this institution.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 190 then
    raise exception 'Choose a range of up to six months.';
  end if;
  select timezone into tz from public.institutions where id = p_inst;
  s := public.institution_settings(p_inst);
  per_day := (s ->> 'max_deadlines_per_day')::integer;
  per_week := (s ->> 'max_deadlines_per_week')::integer;

  return query
  with cls as (
    select c.id, c.name, c.grade from public.classes c
    where c.institution_id = p_inst and not c.archived
      and (p_class is null or c.id = p_class)
      and (p_grade is null or lower(c.grade) = lower(p_grade))
      and public.can_view_class(c.id)
  ),
  dl as (
    select a.class_id as cid, (a.due_at at time zone tz)::date as d,
           jsonb_build_object('id', a.id, 'title', a.title, 'kind', a.kind, 'subject', sub.name, 'subject_id', a.subject_id,
                              'teacher', m.display_name, 'teacher_id', a.teacher_id, 'due_at', a.due_at, 'opens_at', a.opens_at,
                              'status', a.status) as item
    from public.assignments a
    join cls on cls.id = a.class_id
    join public.subjects sub on sub.id = a.subject_id
    join public.institution_memberships m on m.id = a.teacher_id
    where a.status in ('published', 'closed')
      and (a.due_at at time zone tz)::date between (p_from - 6) and (p_to + 6)
      and (p_subject is null or a.subject_id = p_subject)
      and (p_teacher is null or a.teacher_id = p_teacher)
  ),
  ev as (
    select cls.id as cid, gs::date as d, e.kind, e.title, e.id, sub.name as subject
    from public.calendar_events e
    join cls on public.event_applies(e.class_id, e.grade, cls.id, cls.grade)
    left join public.subjects sub on sub.id = e.subject_id
    cross join lateral generate_series(greatest(e.starts_on, p_from)::timestamp, least(e.ends_on, p_to)::timestamp, interval '1 day') gs
    where e.institution_id = p_inst and e.status = 'scheduled' and e.kind in ('exam', 'holiday')
      and e.starts_on <= p_to and e.ends_on >= p_from
      and (p_subject is null or e.kind = 'holiday' or e.subject_id is null or e.subject_id = p_subject)
  ),
  keys as (
    select cid, d from dl where d between p_from and p_to
    union
    select cid, d from ev where kind = 'exam'
  ),
  agg as (
    select k.cid, k.d,
      coalesce((select jsonb_agg(dl.item order by dl.item ->> 'due_at') from dl where dl.cid = k.cid and dl.d = k.d), '[]'::jsonb) as dls,
      coalesce((select jsonb_agg(jsonb_build_object('id', ev.id, 'title', ev.title, 'subject', ev.subject))
                from ev where ev.cid = k.cid and ev.d = k.d and ev.kind = 'exam'), '[]'::jsonb) as exs,
      (select count(*) from dl where dl.cid = k.cid and dl.d = k.d)::integer as n_dl,
      (select count(*) from ev where ev.cid = k.cid and ev.d = k.d and ev.kind = 'exam')::integer as n_ex,
      (select count(*) from dl where dl.cid = k.cid
         and date_trunc('week', dl.d::timestamp) = date_trunc('week', k.d::timestamp))::integer as n_week,
      (select min(ev.title) from ev where ev.cid = k.cid and ev.d = k.d and ev.kind = 'holiday') as hol
    from keys k
  )
  select agg.d, agg.cid, cls.name, cls.grade, agg.dls, agg.exs, agg.n_dl, agg.n_ex, agg.n_week,
         agg.hol is not null, agg.hol,
         array_remove(array[
           case when agg.n_dl >= 2 then 'overlapping_deadlines' end,
           case when agg.n_dl > per_day then 'heavy_day' end,
           case when agg.n_week > per_week then 'heavy_week' end,
           case when agg.n_dl > 0 and agg.n_ex > 0 then 'exam_conflict' end,
           case when agg.n_ex >= 2 then 'multiple_exams' end,
           case when agg.hol is not null then 'holiday' end
         ], null)
  from agg join cls on cls.id = agg.cid
  order by agg.d, cls.grade, cls.name;
end;
$$;
revoke execute on function public.deadline_calendar(uuid, date, date, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.deadline_calendar(uuid, date, date, uuid, text, uuid, uuid) to authenticated;

-- Totals for the dashboard, limited to what the caller can see.
create or replace function public.institution_overview(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  tz text;
  today date;
  conflicts integer;
begin
  if r is null then
    raise exception 'Not a member of this institution.';
  end if;
  select timezone into tz from public.institutions where id = p_inst;
  today := (now() at time zone tz)::date;
  select count(*) into conflicts from public.deadline_calendar(p_inst, today, today + 30) x
   where x.flags && array['heavy_day', 'heavy_week', 'exam_conflict', 'holiday', 'multiple_exams'];

  return jsonb_build_object(
    'role', r,
    'today', today,
    'students', (select count(*) from public.institution_memberships m
                 where m.institution_id = p_inst and m.role = 'student' and m.status = 'active'
                   and public.can_view_membership(p_inst, m.id, m.role, m.user_id)),
    'staff', (select count(*) from public.institution_memberships m
              where m.institution_id = p_inst and public.is_staff_role(m.role) and m.status = 'active'),
    'staff_by_role', (select coalesce(jsonb_object_agg(role, n), '{}'::jsonb) from (
                        select m.role, count(*) n from public.institution_memberships m
                        where m.institution_id = p_inst and m.status = 'active' and public.is_staff_role(m.role)
                        group by m.role) x),
    'suspended', case when public.is_staff_role(r) then (select count(*) from public.institution_memberships m
                  where m.institution_id = p_inst and m.status = 'suspended'
                    and public.can_view_membership(p_inst, m.id, m.role, m.user_id)) end,
    'classes', (select count(*) from public.classes c where c.institution_id = p_inst and not c.archived and public.can_view_class(c.id)),
    'subjects', (select count(*) from public.subjects s where s.institution_id = p_inst and not s.archived),
    'pending_invitations', case when public.has_inst_perm(p_inst, 'manage_staff') or public.has_inst_perm(p_inst, 'manage_students')
                             then (select count(*) from public.institution_invitations i
                                   where i.institution_id = p_inst and i.status = 'pending' and i.expires_at > now()) end,
    'upcoming_exams', (select count(*) from public.calendar_events e
                       where e.institution_id = p_inst and e.kind = 'exam' and e.status = 'scheduled'
                         and e.ends_on >= today and e.starts_on <= today + 14
                         and public.can_view_event(p_inst, e.class_id, e.grade)),
    'deadlines_7d', (select count(*) from public.assignments a
                     where a.institution_id = p_inst and a.status = 'published'
                       and a.due_at >= now() and a.due_at < now() + interval '7 days' and public.can_view_class(a.class_id)),
    'conflicts_30d', conflicts,
    'pending_deadline_requests', case when public.is_staff_role(r) then (select count(*) from public.deadline_change_requests d
                                   join public.assignments a on a.id = d.assignment_id
                                   where d.institution_id = p_inst and d.status = 'pending' and public.can_view_class(a.class_id)) end,
    'current_year', (select jsonb_build_object('id', y.id, 'name', y.name, 'starts_on', y.starts_on, 'ends_on', y.ends_on)
                     from public.academic_years y where y.institution_id = p_inst and y.is_current)
  );
end;
$$;
revoke execute on function public.institution_overview(uuid) from public, anon;
grant execute on function public.institution_overview(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Platform owner functions
-- ---------------------------------------------------------------------
create or replace function public.platform_create_institution(p_name text, p_kind text, p_timezone text, p_short_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can create institutions.';
  end if;
  insert into public.institutions (name, kind, timezone, short_name, created_by)
  values (btrim(p_name), coalesce(p_kind, 'school'), coalesce(nullif(p_timezone, ''), 'Asia/Kolkata'),
          nullif(btrim(coalesce(p_short_name, '')), ''), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;
revoke execute on function public.platform_create_institution(text, text, text, text) from public, anon;
grant execute on function public.platform_create_institution(text, text, text, text) to authenticated;

create or replace function public.platform_set_institution_status(p_inst uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can change an institution''s status.';
  end if;
  if p_status not in ('active', 'suspended', 'archived') then
    raise exception 'Invalid status.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason (at least 3 characters).';
  end if;
  perform set_config('habitflow.audit_reason', p_reason, true);
  update public.institutions set status = p_status where id = p_inst;
  if not found then
    raise exception 'Institution not found.';
  end if;
end;
$$;
revoke execute on function public.platform_set_institution_status(uuid, text, text) from public, anon;
grant execute on function public.platform_set_institution_status(uuid, text, text) to authenticated;

-- Institutions with head counts only (no student data).
create or replace function public.platform_institutions()
returns table (id uuid, name text, short_name text, kind text, status text, timezone text, created_at timestamptz,
               members integer, students integer, staff integer, heads integer, pending_invitations integer, allowlist_entries integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform owner can list institutions.';
  end if;
  return query
  select i.id, i.name, i.short_name, i.kind, i.status, i.timezone, i.created_at,
    (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active')::integer,
    (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active' and m.role = 'student')::integer,
    (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active' and public.is_staff_role(m.role))::integer,
    (select count(*) from public.institution_memberships m where m.institution_id = i.id and m.status = 'active' and m.role in ('principal', 'director'))::integer,
    (select count(*) from public.institution_invitations v where v.institution_id = i.id and v.status = 'pending' and v.expires_at > now())::integer,
    (select count(*) from public.institution_email_allowlist a where a.institution_id = i.id and a.status = 'active')::integer
  from public.institutions i
  order by i.created_at desc;
end;
$$;
revoke execute on function public.platform_institutions() from public, anon;
grant execute on function public.platform_institutions() to authenticated;

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

-- =====================================================================
-- Institutions — Phase 3: parents/guardians, announcements, parent–teacher
-- messages and meeting requests, class timetables, personal goals and
-- achievements, notification preferences and scheduled reminders.
--
-- * A guardian link starts with the student, is approved by the class
--   teacher or someone with manage_students, and becomes active only when the
--   guardian opens a one-time link sent to their email. Parents read their
--   child's data only through guardian_* functions that check the link.
-- * Messages are visible to their two participants only.
-- Additive only. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Notification preferences (in-app can be switched off per kind; email and
-- push are stored now and delivered once those channels are configured)
-- ---------------------------------------------------------------------
create table if not exists public.notification_prefs (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind ~ '^[a-z_]{2,40}$'),
  in_app     boolean not null default true,
  email      boolean not null default false,
  push       boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
drop policy if exists "own" on public.notification_prefs;
create policy "own" on public.notification_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.notification_prefs to authenticated;

create or replace function public.notify(p_user uuid, p_inst uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select p_user, p_inst, p_kind, left(p_title, 200), left(p_body, 1000), p_link, p_dedupe
  where p_user is not null
    and coalesce((select np.in_app from public.notification_prefs np where np.user_id = p_user and np.kind = p_kind), true)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Guardian links
-- ---------------------------------------------------------------------
create table if not exists public.guardian_links (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  student_id       uuid not null,
  guardian_email   text not null check (guardian_email = lower(btrim(guardian_email)) and guardian_email ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  guardian_name    text not null check (char_length(btrim(guardian_name)) between 1 and 80),
  relationship     text not null check (relationship in ('mother', 'father', 'guardian', 'grandparent', 'other')),
  guardian_user_id uuid references auth.users (id) on delete set null,
  status           text not null default 'requested' check (status in ('requested', 'approved', 'active', 'declined', 'revoked')),
  requested_by     uuid references auth.users (id) on delete set null,
  approved_by      uuid references auth.users (id) on delete set null,
  approved_at      timestamptz,
  activated_at     timestamptz,
  closed_by        uuid references auth.users (id) on delete set null,
  closed_at        timestamptz,
  close_reason     text check (close_reason is null or char_length(close_reason) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, institution_id),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create unique index if not exists guardian_links_open_idx on public.guardian_links (student_id, guardian_email)
  where status in ('requested', 'approved', 'active');
create index if not exists guardian_links_guardian_idx on public.guardian_links (guardian_user_id) where status = 'active';

alter table public.institution_invitations add column if not exists guardian_link_id uuid;
alter table public.institution_invitations drop constraint if exists institution_invitations_role_check;
alter table public.institution_invitations add constraint institution_invitations_role_check
  check (role in ('principal', 'director', 'coordinator', 'class_teacher', 'subject_teacher', 'student', 'parent'));
do $$ begin
  alter table public.institution_invitations add constraint institution_invitations_parent_link_check
    check ((role = 'parent') = (guardian_link_id is not null));
exception when duplicate_object then null; end $$;

-- Is the caller (or p_user) an active, verified guardian of this student?
create or replace function public.is_guardian_of_for(p_user uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guardian_links g
    join public.institutions i on i.id = g.institution_id and i.status = 'active'
    join public.institution_memberships s on s.id = g.student_id and s.status = 'active'
    where g.student_id = p_student and g.guardian_user_id = p_user and g.status = 'active'
      and not exists (select 1 from public.institution_memberships pm
                      where pm.institution_id = g.institution_id and pm.user_id = p_user and pm.status <> 'active')
  );
$$;
revoke execute on function public.is_guardian_of_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.is_guardian_of(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_guardian_of_for(auth.uid(), p_student);
$$;
revoke execute on function public.is_guardian_of(uuid) from public, anon;
grant execute on function public.is_guardian_of(uuid) to authenticated;

-- Who may approve a guardian link: manage_students, or the student's class teacher.
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
                      join public.classes c on c.id = e.class_id
                      join public.institution_memberships m on m.id = c.class_teacher_id
                      where e.student_id = g.student_id and m.user_id = p_user and m.status = 'active'))
  );
$$;
revoke execute on function public.can_approve_guardian_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_approve_guardian(p_link uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_approve_guardian_for(auth.uid(), p_link);
$$;
revoke execute on function public.can_approve_guardian(uuid) from public, anon;
grant execute on function public.can_approve_guardian(uuid) to authenticated;

alter table public.guardian_links enable row level security;
revoke all on public.guardian_links from anon, authenticated;
drop policy if exists "read" on public.guardian_links;
create policy "read" on public.guardian_links for select to authenticated
  using (student_id = public.my_membership_id(institution_id)
         or guardian_user_id = (select auth.uid())
         or public.can_approve_guardian(id));
grant select on public.guardian_links to authenticated;

-- Student asks for a guardian to be linked.
create or replace function public.request_guardian_link(p_inst uuid, p_email text, p_name text, p_relationship text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.my_membership_id(p_inst);
  em text := lower(btrim(coalesce(p_email, '')));
  lid uuid;
  r record;
begin
  if me is null or public.inst_role(p_inst) <> 'student' then
    raise exception 'Only students can add a parent or guardian.';
  end if;
  if public.hit_rate_limit(auth.uid()::text, 'guardian_request', 10, 86400) then
    raise exception 'Too many requests today. Please try again tomorrow.';
  end if;
  if em !~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$' or em like '%@habitflow.local' then
    raise exception 'Enter your parent’s or guardian’s email address.';
  end if;
  if em = (select lower(email) from auth.users where id = auth.uid()) then
    raise exception 'Use your parent’s or guardian’s own email address, not yours.';
  end if;
  if (select count(*) from public.guardian_links where student_id = me and status in ('requested', 'approved', 'active')) >= 4 then
    raise exception 'You can link up to 4 parents or guardians.';
  end if;
  insert into public.guardian_links (institution_id, student_id, guardian_email, guardian_name, relationship, requested_by)
  values (p_inst, me, em, btrim(coalesce(p_name, '')), coalesce(p_relationship, 'guardian'), auth.uid())
  returning id into lid;
  -- tell the class teacher(s)
  for r in select distinct m.user_id from public.class_enrollments e
           join public.classes c on c.id = e.class_id
           join public.institution_memberships m on m.id = c.class_teacher_id and m.status = 'active'
           where e.student_id = me loop
    perform public.notify(r.user_id, p_inst, 'guardian_request', 'Parent link to approve',
      (select display_name from public.institution_memberships where id = me) || ' asked to link a parent/guardian.',
      '/school/guardians', 'guardian-req:' || lid);
  end loop;
  return lid;
exception when unique_violation then
  raise exception 'You have already asked to link this email address.';
end;
$$;
revoke execute on function public.request_guardian_link(uuid, text, text, text) from public, anon;
grant execute on function public.request_guardian_link(uuid, text, text, text) to authenticated;

-- Approval creates the parent invitation (server function only; it emails the token).
create or replace function public.create_guardian_invitation(p_actor uuid, p_link uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.guardian_links;
  inst public.institutions;
  inv_id uuid;
  exp timestamptz := now() + interval '7 days';
  student_name text;
begin
  perform set_config('habitflow.actor', p_actor::text, true);
  select * into g from public.guardian_links where id = p_link for update;
  if g.id is null or not public.can_approve_guardian_for(p_actor, p_link) then
    raise exception 'Request not found.';
  end if;
  if g.status not in ('requested', 'approved') then
    raise exception 'This request has already been %.', g.status;
  end if;
  select * into inst from public.institutions where id = g.institution_id;
  if inst.status <> 'active' then
    raise exception 'This institution is not active.';
  end if;
  update public.institution_invitations set status = 'revoked', token_hash = null
   where guardian_link_id = g.id and status = 'pending';
  insert into public.institution_invitations
    (institution_id, email, role, display_name, token_hash, expires_at, invited_by, send_count, last_sent_at, guardian_link_id)
  values (g.institution_id, g.guardian_email, 'parent', g.guardian_name, p_token_hash, exp, p_actor, 1, now(), g.id)
  returning id into inv_id;
  update public.guardian_links set status = 'approved', approved_by = p_actor, approved_at = coalesce(approved_at, now()) where id = g.id;
  select display_name into student_name from public.institution_memberships where id = g.student_id;
  return jsonb_build_object('id', inv_id, 'email', g.guardian_email, 'expires_at', exp, 'institution', inst.name,
                            'role', 'parent', 'display_name', g.guardian_name, 'student', student_name);
end;
$$;
revoke execute on function public.create_guardian_invitation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_guardian_invitation(uuid, uuid, text) to service_role;

-- Decline (approvers) or revoke (student, guardian or approvers), with a reason.
create or replace function public.close_guardian_link(p_link uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.guardian_links;
  is_student boolean;
begin
  select * into g from public.guardian_links where id = p_link for update;
  if g.id is null then
    raise exception 'Link not found.';
  end if;
  is_student := g.student_id = public.my_membership_id(g.institution_id);
  if not (is_student or g.guardian_user_id = auth.uid() or public.can_approve_guardian(p_link)) then
    raise exception 'Link not found.';
  end if;
  if g.status in ('declined', 'revoked') then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason (at least 3 characters).';
  end if;
  perform set_config('habitflow.audit_reason', p_reason, true);
  update public.guardian_links
     set status = case when g.status = 'active' then 'revoked' else case when is_student then 'revoked' else 'declined' end end,
         closed_by = auth.uid(), closed_at = now(), close_reason = btrim(p_reason)
   where id = g.id;
  update public.institution_invitations set status = 'revoked', token_hash = null where guardian_link_id = g.id and status = 'pending';
end;
$$;
revoke execute on function public.close_guardian_link(uuid, text) from public, anon;
grant execute on function public.close_guardian_link(uuid, text) to authenticated;

-- Account creation / acceptance now handle parent invitations.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  inv_text text := coalesce(current_setting('habitflow.invitation_id', true), '');
  inv public.institution_invitations;
  mid uuid;
begin
  if lower(new.email) like '%@habitflow.local' then
    if uname !~ '^[a-z0-9_.-]{3,24}$' then
      raise exception 'Invalid username';
    end if;
    if lower(new.email) <> uname || '@habitflow.local' then
      raise exception 'Username does not match login';
    end if;
    insert into public.profiles (id, username) values (new.id, uname);
    return new;
  end if;

  if inv_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Institutional accounts can only be created from an invitation.';
  end if;
  select * into inv from public.institution_invitations where id = inv_text::uuid for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at < now() or inv.email <> lower(new.email) then
    raise exception 'This invitation is invalid or has expired.';
  end if;

  perform set_config('habitflow.actor', new.id::text, true);
  insert into public.profiles (id, username, account_type, display_name)
  values (new.id, 'i' || substr(replace(new.id::text, '-', ''), 1, 15), 'institutional', inv.display_name);
  insert into public.institution_memberships (institution_id, user_id, role, display_name, external_id)
  values (inv.institution_id, new.id, inv.role, inv.display_name, inv.external_id)
  returning id into mid;
  update public.institution_invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = new.id, membership_id = mid, token_hash = null
   where id = inv.id;
  if inv.guardian_link_id is not null then
    update public.guardian_links set guardian_user_id = new.id, status = 'active', activated_at = now()
     where id = inv.guardian_link_id and status = 'approved';
  end if;
  return new;
end;
$$;

create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  inv public.institution_invitations;
  mid uuid;
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;
  if p_token is null or length(p_token) < 32 then
    raise exception 'This invitation link is invalid.';
  end if;
  select * into inv from public.institution_invitations
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at < now() then
    raise exception 'This invitation link is invalid or has expired.';
  end if;
  if inv.email <> (select lower(email) from auth.users where id = me) then
    raise exception 'This invitation was sent to a different email address. Log in with that address.';
  end if;
  select id into mid from public.institution_memberships where institution_id = inv.institution_id and user_id = me;
  if mid is not null and inv.role <> 'parent' then
    raise exception 'You already have an account at this institution.';
  end if;
  if mid is null then
    insert into public.institution_memberships (institution_id, user_id, role, display_name, external_id)
    values (inv.institution_id, me, inv.role, inv.display_name, inv.external_id)
    returning id into mid;
  end if;
  update public.institution_invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = me, membership_id = mid, token_hash = null
   where id = inv.id;
  if inv.guardian_link_id is not null then
    update public.guardian_links set guardian_user_id = me, status = 'active', activated_at = now()
     where id = inv.guardian_link_id and status = 'approved';
  end if;
  return jsonb_build_object('institution_id', inv.institution_id, 'membership_id', mid);
end;
$$;
revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Parents' own membership rows are visible to themselves and heads; staff
-- see guardian names through the messaging functions.

-- ---------------------------------------------------------------------
-- Class timetables (fixed school periods)
-- ---------------------------------------------------------------------
create table if not exists public.class_periods (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  class_id       uuid not null,
  day_of_week    smallint not null check (day_of_week between 0 and 6),
  start_time     time not null,
  end_time       time not null,
  subject_id     uuid,
  teacher_id     uuid,
  label          text check (label is null or char_length(btrim(label)) between 1 and 40),
  room           text check (room is null or char_length(btrim(room)) between 1 and 30),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_time > start_time),
  check (subject_id is not null or label is not null),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade,
  foreign key (subject_id, institution_id) references public.subjects (id, institution_id),
  foreign key (teacher_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists class_periods_class_idx on public.class_periods (class_id, day_of_week, start_time);

create or replace function public.check_class_period()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.class_periods p
             where p.class_id = new.class_id and p.day_of_week = new.day_of_week and p.id <> new.id
               and p.start_time < new.end_time and new.start_time < p.end_time) then
    raise exception 'This period overlaps another period of the class.' using errcode = '23P01';
  end if;
  return new;
end;
$$;
drop trigger if exists class_periods_overlap on public.class_periods;
create trigger class_periods_overlap before insert or update on public.class_periods
  for each row execute function public.check_class_period();

alter table public.class_periods enable row level security;
revoke all on public.class_periods from anon, authenticated;
drop policy if exists "read" on public.class_periods;
create policy "read" on public.class_periods for select to authenticated using (public.can_view_class(class_id));
drop policy if exists "manage" on public.class_periods;
create policy "manage" on public.class_periods for all to authenticated
  using (public.can_manage_class(class_id)) with check (public.can_manage_class(class_id));
grant select, insert, update, delete on public.class_periods to authenticated;

-- Teachers booked in two classes at once (coordinator timetable report).
create or replace function public.timetable_conflicts(p_inst uuid)
returns table (teacher_id uuid, teacher text, day_of_week smallint, a_class text, a_start time, a_end time, b_class text, b_start time, b_end time)
language sql
stable
security definer
set search_path = ''
as $$
  select p.teacher_id, m.display_name, p.day_of_week, ca.name, p.start_time, p.end_time, cb.name, q.start_time, q.end_time
  from public.class_periods p
  join public.class_periods q on q.teacher_id = p.teacher_id and q.day_of_week = p.day_of_week and q.id > p.id
       and q.start_time < p.end_time and p.start_time < q.end_time
  join public.institution_memberships m on m.id = p.teacher_id
  join public.classes ca on ca.id = p.class_id
  join public.classes cb on cb.id = q.class_id
  where p.institution_id = p_inst
    and public.is_staff_role(public.inst_role(p_inst))
    and (public.can_view_class(p.class_id) or public.can_view_class(q.class_id))
  order by p.day_of_week, p.start_time;
$$;
revoke execute on function public.timetable_conflicts(uuid) from public, anon;
grant execute on function public.timetable_conflicts(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  title          text not null check (char_length(btrim(title)) between 1 and 120),
  body           text not null check (char_length(btrim(body)) between 1 and 4000),
  audience       text not null check (audience in ('everyone', 'staff', 'students', 'parents', 'students_parents')),
  grade          text check (grade is null or char_length(btrim(grade)) between 1 and 30),
  class_id       uuid,
  created_by     uuid references auth.users (id) on delete set null,
  author_name    text,
  created_at     timestamptz not null default now(),
  check (class_id is null or grade is null),
  foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete cascade
);
create index if not exists announcements_inst_idx on public.announcements (institution_id, created_at desc);

-- Students in scope of a grade/class target.
create or replace function public.student_in_target(p_student uuid, p_grade text, p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (p_grade is null and p_class is null)
      or exists (select 1 from public.class_enrollments e join public.classes c on c.id = e.class_id
                 where e.student_id = p_student and (c.id = p_class or (p_class is null and lower(c.grade) = lower(p_grade))));
$$;
revoke execute on function public.student_in_target(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.can_view_announcement(p_inst uuid, p_audience text, p_grade text, p_class uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
begin
  if r is not null and public.is_staff_role(r) then
    return true;
  end if;
  if r = 'student' and p_audience in ('everyone', 'students', 'students_parents') then
    return public.student_in_target(public.my_membership_id(p_inst), p_grade, p_class);
  end if;
  if p_audience in ('everyone', 'parents', 'students_parents') then
    return exists (select 1 from public.guardian_links g
                   where g.institution_id = p_inst and g.guardian_user_id = auth.uid() and g.status = 'active'
                     and public.is_guardian_of(g.student_id) and public.student_in_target(g.student_id, p_grade, p_class));
  end if;
  return false;
end;
$$;
revoke execute on function public.can_view_announcement(uuid, text, text, uuid) from public, anon;
grant execute on function public.can_view_announcement(uuid, text, text, uuid) to authenticated;

alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated;
drop policy if exists "read" on public.announcements;
create policy "read" on public.announcements for select to authenticated
  using (public.can_view_announcement(institution_id, audience, grade, class_id));
grant select on public.announcements to authenticated;

create or replace function public.post_announcement(p_inst uuid, p_title text, p_body text, p_audience text, p_grade text default null, p_class uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text := public.inst_role(p_inst);
  me uuid := public.my_membership_id(p_inst);
  aid uuid;
  allowed boolean;
  g text := nullif(btrim(coalesce(p_grade, '')), '');
begin
  if r is null or not public.is_staff_role(r) then
    raise exception 'You can’t post announcements.';
  end if;
  allowed := case
    when r in ('principal', 'director') then true
    when r = 'coordinator' then
      (p_class is not null and public.can_view_class(p_class))
      or (g is not null and public.in_coordinator_scope(p_inst, g))
      or (p_class is null and g is null and exists (select 1 from public.coordinator_scopes s where s.coordinator_id = me and s.grade = '*'))
    else p_class is not null and exists (select 1 from public.classes c where c.id = p_class and c.class_teacher_id = me)
  end;
  if not allowed then
    raise exception 'You can only post announcements for the classes or grades you look after.';
  end if;
  if p_audience = 'staff' and r not in ('principal', 'director') then
    raise exception 'Only principals and directors can post staff announcements.';
  end if;
  if public.hit_rate_limit(auth.uid()::text, 'announcement', 30, 86400) then
    raise exception 'Too many announcements today.';
  end if;
  insert into public.announcements (institution_id, title, body, audience, grade, class_id, created_by, author_name)
  values (p_inst, btrim(p_title), btrim(p_body), p_audience, g, p_class, auth.uid(),
          (select display_name from public.institution_memberships where id = me))
  returning id into aid;

  -- In-app notification for each recipient (deduplicated).
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select distinct u.uid, p_inst, 'announcement', left(btrim(p_title), 200), left(btrim(p_body), 300), '/school/announcements', 'ann:' || aid
  from (
    select m.user_id as uid from public.institution_memberships m
    where m.institution_id = p_inst and m.status = 'active' and m.user_id is not null
      and ((p_audience in ('everyone', 'staff') and public.is_staff_role(m.role))
           or (p_audience in ('everyone', 'students', 'students_parents') and m.role = 'student' and public.student_in_target(m.id, g, p_class)))
    union
    select gl.guardian_user_id from public.guardian_links gl
    where gl.institution_id = p_inst and gl.status = 'active' and gl.guardian_user_id is not null
      and p_audience in ('everyone', 'parents', 'students_parents') and public.student_in_target(gl.student_id, g, p_class)
  ) u
  where u.uid <> auth.uid()
    and coalesce((select np.in_app from public.notification_prefs np where np.user_id = u.uid and np.kind = 'announcement'), true)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  return aid;
end;
$$;
revoke execute on function public.post_announcement(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.post_announcement(uuid, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Parent–teacher conversations and meeting requests
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  institution_id   uuid not null references public.institutions (id) on delete cascade,
  student_id       uuid not null,
  guardian_user_id uuid not null references auth.users (id) on delete cascade,
  staff_user_id    uuid not null references auth.users (id) on delete cascade,
  subject          text not null check (char_length(btrim(subject)) between 1 and 120),
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  foreign key (student_id, institution_id) references public.institution_memberships (id, institution_id)
);
create index if not exists conversations_guardian_idx on public.conversations (guardian_user_id, last_message_at desc);
create index if not exists conversations_staff_idx on public.conversations (staff_user_id, last_message_at desc);

create table if not exists public.conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid references auth.users (id) on delete set null,
  kind            text not null default 'text' check (kind in ('text', 'meeting_request')),
  body            text not null check (char_length(btrim(body)) between 1 and 4000),
  meeting_at      timestamptz,
  meeting_status  text check (meeting_status in ('proposed', 'accepted', 'declined')),
  created_at      timestamptz not null default now(),
  check ((kind = 'meeting_request') = (meeting_at is not null and meeting_status is not null))
);
create index if not exists conversation_messages_idx on public.conversation_messages (conversation_id, created_at);

-- Participant who still has the right to talk about this student.
create or replace function public.in_conversation(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation
      and ((c.guardian_user_id = auth.uid() and public.is_guardian_of(c.student_id))
           or (c.staff_user_id = auth.uid() and public.inst_role(c.institution_id) is not null
               and public.is_staff_role(public.inst_role(c.institution_id))))
  );
$$;
revoke execute on function public.in_conversation(uuid) from public, anon;
grant execute on function public.in_conversation(uuid) to authenticated;

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
revoke all on public.conversations, public.conversation_messages from anon, authenticated;
drop policy if exists "participants" on public.conversations;
create policy "participants" on public.conversations for select to authenticated using (public.in_conversation(id));
drop policy if exists "participants" on public.conversation_messages;
create policy "participants" on public.conversation_messages for select to authenticated using (public.in_conversation(conversation_id));
grant select on public.conversations, public.conversation_messages to authenticated;

-- Staff a guardian may contact about a child: class teacher, subject teachers, in-scope coordinators, heads.
create or replace function public.guardian_contacts(p_student uuid)
returns table (user_id uuid, name text, role text, detail text)
language sql
stable
security definer
set search_path = ''
as $$
  with kid as (
    select s.id, s.institution_id from public.institution_memberships s where s.id = p_student and public.is_guardian_of(p_student)
  ),
  cls as (
    select c.* from public.classes c join public.class_enrollments e on e.class_id = c.id join kid on kid.id = e.student_id
  )
  select distinct on (m.user_id) m.user_id, m.display_name, m.role,
    coalesce(
      (select 'Class teacher, ' || cls.name from cls where cls.class_teacher_id = m.id limit 1),
      (select string_agg(sub.name, ', ') from public.teaching_assignments t join cls on cls.id = t.class_id
         join public.subjects sub on sub.id = t.subject_id where t.teacher_id = m.id),
      case m.role when 'coordinator' then 'Coordinator' when 'principal' then 'Principal' when 'director' then 'Director' end)
  from public.institution_memberships m, kid
  where m.institution_id = kid.institution_id and m.status = 'active' and m.user_id is not null
    and (m.role in ('principal', 'director')
         or exists (select 1 from cls where cls.class_teacher_id = m.id)
         or exists (select 1 from public.teaching_assignments t join cls on cls.id = t.class_id where t.teacher_id = m.id)
         or (m.role = 'coordinator' and exists (select 1 from public.coordinator_scopes sc join cls on true
                                                 where sc.coordinator_id = m.id and (sc.grade = '*' or lower(sc.grade) = lower(cls.grade)))))
  order by m.user_id;
$$;
revoke execute on function public.guardian_contacts(uuid) from public, anon;
grant execute on function public.guardian_contacts(uuid) to authenticated;

-- Guardians of a student that this staff member may message.
create or replace function public.student_guardians(p_student uuid)
returns table (user_id uuid, name text, relationship text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.guardian_user_id, g.guardian_name, g.relationship
  from public.guardian_links g
  join public.institution_memberships s on s.id = g.student_id
  where g.student_id = p_student and g.status = 'active' and g.guardian_user_id is not null
    and public.has_inst_perm(s.institution_id, 'message_parents')
    and exists (select 1 from public.class_enrollments e where e.student_id = s.id and public.can_view_class(e.class_id));
$$;
revoke execute on function public.student_guardians(uuid) from public, anon;
grant execute on function public.student_guardians(uuid) to authenticated;

create or replace function public.start_conversation(p_student uuid, p_counterpart uuid, p_subject text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.institution_memberships;
  cid uuid;
  guardian uuid;
  staff uuid;
begin
  select * into s from public.institution_memberships where id = p_student and role = 'student';
  if s.id is null then
    raise exception 'Student not found.';
  end if;
  if public.is_guardian_of(p_student) then
    if not exists (select 1 from public.guardian_contacts(p_student) gc where gc.user_id = p_counterpart) then
      raise exception 'You can message your child’s teachers, coordinators and the principal.';
    end if;
    guardian := auth.uid();
    staff := p_counterpart;
  elsif exists (select 1 from public.student_guardians(p_student) sg where sg.user_id = p_counterpart) then
    guardian := p_counterpart;
    staff := auth.uid();
  else
    raise exception 'You can’t start this conversation.';
  end if;
  if public.hit_rate_limit(auth.uid()::text, 'conversation', 30, 86400) then
    raise exception 'Too many new conversations today.';
  end if;
  insert into public.conversations (institution_id, student_id, guardian_user_id, staff_user_id, subject)
  values (s.institution_id, p_student, guardian, staff, btrim(p_subject))
  returning id into cid;
  perform public.send_message(cid, p_body, 'text', null);
  return cid;
end;
$$;
revoke execute on function public.start_conversation(uuid, uuid, text, text) from public, anon;
grant execute on function public.start_conversation(uuid, uuid, text, text) to authenticated;

create or replace function public.send_message(p_conversation uuid, p_body text, p_kind text default 'text', p_meeting_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.conversations;
  mid uuid;
  other uuid;
begin
  select * into c from public.conversations where id = p_conversation;
  if c.id is null or not public.in_conversation(p_conversation) then
    raise exception 'Conversation not found.';
  end if;
  if p_kind not in ('text', 'meeting_request') then
    raise exception 'Invalid message type.';
  end if;
  if p_kind = 'meeting_request' and (p_meeting_at is null or p_meeting_at < now()) then
    raise exception 'Choose a future date and time for the meeting.';
  end if;
  if public.hit_rate_limit(auth.uid()::text, 'message', 200, 86400) then
    raise exception 'Too many messages today.';
  end if;
  insert into public.conversation_messages (conversation_id, sender_id, kind, body, meeting_at, meeting_status)
  values (c.id, auth.uid(), p_kind, btrim(p_body), case when p_kind = 'meeting_request' then p_meeting_at end,
          case when p_kind = 'meeting_request' then 'proposed' end)
  returning id into mid;
  update public.conversations set last_message_at = now() where id = c.id;
  other := case when auth.uid() = c.guardian_user_id then c.staff_user_id else c.guardian_user_id end;
  perform public.notify(other, c.institution_id, case when p_kind = 'meeting_request' then 'meeting_request' else 'message' end,
    case when p_kind = 'meeting_request' then 'Meeting request: ' else 'New message: ' end || c.subject,
    left(btrim(p_body), 200), '/school/messages?c=' || c.id, 'msg:' || mid);
  return mid;
end;
$$;
revoke execute on function public.send_message(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.send_message(uuid, text, text, timestamptz) to authenticated;

create or replace function public.respond_meeting(p_message uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.conversation_messages;
  c public.conversations;
begin
  select * into m from public.conversation_messages where id = p_message for update;
  select * into c from public.conversations where id = m.conversation_id;
  if m.id is null or not public.in_conversation(c.id) or m.kind <> 'meeting_request' then
    raise exception 'Meeting request not found.';
  end if;
  if m.sender_id = auth.uid() then
    raise exception 'The other person answers a meeting request.';
  end if;
  if m.meeting_status <> 'proposed' then
    raise exception 'This request has already been answered.';
  end if;
  update public.conversation_messages set meeting_status = case when p_accept then 'accepted' else 'declined' end where id = m.id;
  perform public.notify(m.sender_id, c.institution_id, 'meeting_response',
    'Meeting ' || case when p_accept then 'accepted' else 'declined' end || ': ' || c.subject,
    to_char(m.meeting_at at time zone (select timezone from public.institutions where id = c.institution_id), 'DD Mon YYYY HH24:MI'),
    '/school/messages?c=' || c.id, 'meet:' || m.id);
end;
$$;
revoke execute on function public.respond_meeting(uuid, boolean) from public, anon;
grant execute on function public.respond_meeting(uuid, boolean) to authenticated;

create or replace function public.my_conversations()
returns table (id uuid, institution_id uuid, subject text, student text, counterpart text, counterpart_role text, i_am_guardian boolean,
               last_message_at timestamptz, last_body text, unread boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.institution_id, c.subject, s.display_name,
    case when c.guardian_user_id = auth.uid()
         then (select m.display_name from public.institution_memberships m where m.institution_id = c.institution_id and m.user_id = c.staff_user_id)
         else (select g.guardian_name from public.guardian_links g where g.student_id = c.student_id and g.guardian_user_id = c.guardian_user_id and g.status = 'active' limit 1) end,
    case when c.guardian_user_id = auth.uid()
         then (select m.role from public.institution_memberships m where m.institution_id = c.institution_id and m.user_id = c.staff_user_id)
         else 'parent' end,
    c.guardian_user_id = auth.uid(),
    c.last_message_at,
    (select left(x.body, 120) from public.conversation_messages x where x.conversation_id = c.id order by x.created_at desc limit 1),
    exists (select 1 from public.notifications n where n.user_id = auth.uid() and n.read_at is null and n.link = '/school/messages?c=' || c.id)
  from public.conversations c
  join public.institution_memberships s on s.id = c.student_id
  where (c.guardian_user_id = auth.uid() or c.staff_user_id = auth.uid()) and public.in_conversation(c.id)
  order by c.last_message_at desc;
$$;
revoke execute on function public.my_conversations() from public, anon;
grant execute on function public.my_conversations() to authenticated;

-- ---------------------------------------------------------------------
-- Parent view of a linked child (one function, explicit data contract)
-- ---------------------------------------------------------------------
create or replace function public.guardian_children()
returns table (student_id uuid, institution_id uuid, institution text, name text, relationship text, classes text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.student_id, g.institution_id, i.name, s.display_name, g.relationship,
    (select string_agg(c.name, ', ') from public.class_enrollments e join public.classes c on c.id = e.class_id where e.student_id = s.id)
  from public.guardian_links g
  join public.institution_memberships s on s.id = g.student_id
  join public.institutions i on i.id = g.institution_id
  where g.guardian_user_id = auth.uid() and g.status = 'active' and public.is_guardian_of(g.student_id)
  order by s.display_name;
$$;
revoke execute on function public.guardian_children() from public, anon;
grant execute on function public.guardian_children() to authenticated;

create or replace function public.guardian_child_view(p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.institution_memberships;
  tz text;
  today date;
begin
  if not public.is_guardian_of(p_student) then
    raise exception 'Not found.';
  end if;
  select * into s from public.institution_memberships where id = p_student;
  select timezone into tz from public.institutions where id = s.institution_id;
  today := (now() at time zone tz)::date;
  return jsonb_build_object(
    'student', jsonb_build_object('id', s.id, 'name', s.display_name),
    'classes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'grade', c.grade,
                   'class_teacher', (select m.display_name from public.institution_memberships m where m.id = c.class_teacher_id)))
                 from public.class_enrollments e join public.classes c on c.id = e.class_id where e.student_id = s.id), '[]'::jsonb),
    'timetable', coalesce((select jsonb_agg(jsonb_build_object('day', p.day_of_week, 'start', p.start_time, 'end', p.end_time,
                   'subject', sub.name, 'label', p.label, 'room', p.room) order by p.day_of_week, p.start_time)
                 from public.class_periods p join public.class_enrollments e on e.class_id = p.class_id
                 left join public.subjects sub on sub.id = p.subject_id where e.student_id = s.id), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'kind', a.kind, 'subject', sub.name,
                   'opens_at', a.opens_at, 'due_at', a.due_at, 'status', coalesce(x.status, 'not_submitted'), 'is_late', coalesce(x.is_late, false),
                   'feedback', case when x.status in ('accepted', 'resubmission_requested', 'rejected') then x.feedback end) order by a.due_at desc)
                 from public.assignments a join public.class_enrollments e on e.class_id = a.class_id and e.student_id = s.id
                 join public.subjects sub on sub.id = a.subject_id
                 left join public.submissions x on x.assignment_id = a.id and x.student_id = s.id
                 where a.status in ('published', 'closed') and a.due_at > now() - interval '45 days'), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(jsonb_build_object('date', r.session_date, 'period', r.period, 'subject', sub.name, 'status', r.status) order by r.session_date desc, r.period)
                 from public.attendance_records r left join public.subjects sub on sub.id = r.subject_id
                 where r.student_id = s.id and r.session_date > today - 60), '[]'::jsonb),
    'marks', coalesce((select jsonb_agg(jsonb_build_object('title', a.title, 'kind', a.kind, 'subject', sub.name, 'date', a.assessment_date,
                   'max', a.max_marks, 'obtained', k.obtained, 'absent', k.absent, 'feedback', k.feedback,
                   'grade', case when k.obtained is not null then public.grade_for(a.institution_id, k.obtained / a.max_marks * 100) end) order by a.assessment_date desc)
                 from public.marks k join public.assessments a on a.id = k.assessment_id join public.subjects sub on sub.id = a.subject_id
                 where k.student_id = s.id and a.status = 'published'), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', ev.id, 'kind', ev.kind, 'title', ev.title, 'starts_on', ev.starts_on, 'ends_on', ev.ends_on,
                   'start_time', ev.start_time, 'subject', sub.name) order by ev.starts_on)
                 from public.calendar_events ev left join public.subjects sub on sub.id = ev.subject_id
                 where ev.institution_id = s.institution_id and ev.status = 'scheduled' and ev.ends_on >= today and ev.starts_on <= today + 60
                   and exists (select 1 from public.class_enrollments e join public.classes c on c.id = e.class_id
                               where e.student_id = s.id and public.event_applies(ev.class_id, ev.grade, c.id, c.grade))), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.guardian_child_view(uuid) from public, anon;
grant execute on function public.guardian_child_view(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Personal goals (any account) and derived achievements
-- ---------------------------------------------------------------------
create table if not exists public.student_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 120),
  description  text check (description is null or char_length(description) <= 1000),
  category     text not null default 'academic' check (category in ('academic', 'skill', 'health', 'extracurricular', 'personal')),
  target_date  date,
  progress     smallint not null default 0 check (progress between 0 and 100),
  status       text not null default 'active' check (status in ('active', 'completed', 'archived')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists student_goals_user_idx on public.student_goals (user_id, status);
alter table public.student_goals enable row level security;
revoke all on public.student_goals from anon, authenticated;
drop policy if exists "own rows" on public.student_goals;
create policy "own rows" on public.student_goals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.student_goals to authenticated;

create or replace function public.goal_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'completed' then
    new.progress := 100;
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists student_goals_rules on public.student_goals;
create trigger student_goals_rules before insert or update on public.student_goals for each row execute function public.goal_rules();
drop trigger if exists student_goals_limit on public.student_goals;

-- Achievements are computed from real records, so they can't be faked.
create or replace function public.my_achievements()
returns table (id text, title text, description text, earned boolean, progress integer, target integer)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select auth.uid() as uid),
  subs as (
    select s.* from public.submissions s join public.institution_memberships m on m.id = s.student_id, me where m.user_id = me.uid
  ),
  goals as (select g.* from public.student_goals g, me where g.user_id = me.uid),
  focus as (select coalesce(sum(p.focus_seconds), 0) / 3600 as hours from public.pomodoro_sessions p, me where p.user_id = me.uid),
  streak as (
    select count(distinct c.completion_date) as days from public.task_completions c, me
    where c.user_id = me.uid and c.completed and c.completion_date > current_date - 30
  )
  select x.id, x.title, x.description, x.n >= x.target, least(x.n, x.target)::integer, x.target
  from (values
    ('first_accepted', 'First accepted work', 'A teacher accepted your submitted work.', (select count(*) from subs where status = 'accepted'), 1),
    ('on_time_5', 'On time ×5', 'Submitted five pieces of work before the deadline.', (select count(*) from subs where status <> 'not_submitted' and not is_late), 5),
    ('goal_done', 'Goal reached', 'Completed one of your personal goals.', (select count(*) from goals where status = 'completed'), 1),
    ('goals_3', 'Goal getter', 'Completed three personal goals.', (select count(*) from goals where status = 'completed'), 3),
    ('focus_10', '10 focus hours', 'Ten hours in the focus timer.', (select hours from focus), 10),
    ('consistent_20', 'Consistent month', 'Ticked off habits on 20 of the last 30 days.', (select days from streak), 20)
  ) as x(id, title, description, n, target);
$$;
revoke execute on function public.my_achievements() from public, anon;
grant execute on function public.my_achievements() to authenticated;

-- ---------------------------------------------------------------------
-- Scheduled reminders (hourly, in-app; duplicate-proof via dedupe keys)
-- ---------------------------------------------------------------------
create or replace function public.send_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  k integer;
begin
  -- Homework due within 24 hours, not yet submitted.
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select m.user_id, a.institution_id, 'deadline_reminder', 'Due soon: ' || a.title,
         'Due ' || to_char(a.due_at at time zone i.timezone, 'Dy DD Mon HH24:MI') || '. Upload your work before then.',
         '/school/assignments', 'due24:' || a.id || ':' || m.id
  from public.assignments a
  join public.institutions i on i.id = a.institution_id and i.status = 'active'
  join public.class_enrollments e on e.class_id = a.class_id
  join public.institution_memberships m on m.id = e.student_id and m.status = 'active' and m.user_id is not null
  left join public.submissions s on s.assignment_id = a.id and s.student_id = m.id
  where a.status = 'published' and a.due_at > now() and a.due_at <= now() + interval '24 hours' and a.opens_at <= now()
    and coalesce(s.status, 'not_submitted') in ('not_submitted', 'resubmission_requested')
    and coalesce((select np.in_app from public.notification_prefs np where np.user_id = m.user_id and np.kind = 'deadline_reminder'), true)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics k = row_count;
  n := n + k;

  -- Overdue (late submissions still accepted), once.
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select m.user_id, a.institution_id, 'overdue', 'Overdue: ' || a.title, 'The deadline has passed. Late work is still accepted (marked late).',
         '/school/assignments', 'overdue:' || a.id || ':' || m.id
  from public.assignments a
  join public.institutions i on i.id = a.institution_id and i.status = 'active'
  join public.class_enrollments e on e.class_id = a.class_id
  join public.institution_memberships m on m.id = e.student_id and m.status = 'active' and m.user_id is not null
  left join public.submissions s on s.assignment_id = a.id and s.student_id = m.id
  where a.status = 'published' and a.late_policy = 'accept_marked_late'
    and a.due_at < now() and a.due_at > now() - interval '24 hours'
    and coalesce(s.status, 'not_submitted') = 'not_submitted'
    and coalesce((select np.in_app from public.notification_prefs np where np.user_id = m.user_id and np.kind = 'overdue'), true)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics k = row_count;
  n := n + k;

  -- Exams tomorrow: students and their guardians.
  insert into public.notifications (user_id, institution_id, kind, title, body, link, dedupe_key)
  select distinct u.uid, ev.institution_id, 'exam_reminder', 'Exam tomorrow: ' || ev.title,
         coalesce(to_char(ev.start_time, 'HH24:MI'), 'All day'), '/school/calendar', 'exam1:' || ev.id || ':' || u.uid
  from public.calendar_events ev
  join public.institutions i on i.id = ev.institution_id and i.status = 'active'
  join public.classes c on c.institution_id = ev.institution_id and public.event_applies(ev.class_id, ev.grade, c.id, c.grade)
  join public.class_enrollments e on e.class_id = c.id
  join public.institution_memberships m on m.id = e.student_id and m.status = 'active'
  cross join lateral (
    select m.user_id as uid
    union all
    select g.guardian_user_id from public.guardian_links g where g.student_id = m.id and g.status = 'active' and g.guardian_user_id is not null
  ) u
  where ev.kind = 'exam' and ev.status = 'scheduled' and ev.starts_on = (now() at time zone i.timezone)::date + 1
    and u.uid is not null
    and coalesce((select np.in_app from public.notification_prefs np where np.user_id = u.uid and np.kind = 'exam_reminder'), true)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics k = row_count;
  n := n + k;
  return n;
end;
$$;
revoke execute on function public.send_reminders() from public, anon, authenticated;

select cron.unschedule('send-reminders') where exists (select 1 from cron.job where jobname = 'send-reminders');
select cron.schedule('send-reminders', '5 * * * *', 'select public.send_reminders()');

-- ---------------------------------------------------------------------
-- Triggers: updated_at, institution pinning, audit
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['guardian_links', 'class_periods'] loop
    execute format('drop trigger if exists %1$s_updated_at on public.%1$I', t);
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['guardian_links', 'class_periods', 'announcements', 'conversations'] loop
    execute format('drop trigger if exists %1$s_keep_inst on public.%1$I', t);
    execute format('create trigger %1$s_keep_inst before update on public.%1$I for each row execute function public.keep_institution_id()', t);
  end loop;
  foreach t in array array['guardian_links', 'class_periods', 'announcements'] loop
    execute format('drop trigger if exists %1$s_audit on public.%1$I', t);
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$I for each row execute function public.audit_row_change()', t);
  end loop;
end $$;

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
