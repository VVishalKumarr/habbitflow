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
