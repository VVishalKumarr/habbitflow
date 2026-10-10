-- =====================================================================
-- Phase 8: notification delivery by email and push.
--
-- Every in-app notification may also go out by email and/or push, per kind,
-- as each person chooses (notification_prefs.email / .push — off by default).
-- * A trigger queues one delivery per enabled channel (unique per
--   notification and channel, so nothing is sent twice).
-- * Push goes out at once to every registered device (browser or Android).
-- * Email waits 10 minutes and is skipped if the person has already read the
--   notification in the app or it reached one of their devices by push —
--   email is the fallback, not a duplicate. At most 6 emails per person per
--   hour; the rest stay in the app.
-- * The notify-deliver Edge Function (pg_cron, every minute, only when
--   something is due) claims deliveries, sends them and records the result;
--   failures retry with backoff (3 attempts). Channels without credentials
--   are recorded as skipped ("not configured"), never as sent.
-- Additive. Safe to re-run.
-- =====================================================================

create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind            text not null check (kind in ('web', 'fcm')),
  endpoint        text not null check (char_length(endpoint) between 10 and 1000),
  p256dh          text check (p256dh is null or p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth            text check (auth is null or auth ~ '^[A-Za-z0-9_-]{16,30}$'),
  device_label    text check (device_label is null or char_length(device_label) <= 100),
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failures        smallint not null default 0,
  unique (endpoint),
  check (kind = 'fcm' or (endpoint ~ '^https://' and p256dh is not null and auth is not null))
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
drop policy if exists "own" on public.push_subscriptions;
create policy "own" on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select (id, kind, device_label, created_at, last_success_at) on public.push_subscriptions to authenticated;
grant insert (kind, endpoint, p256dh, auth, device_label) on public.push_subscriptions to authenticated;
grant delete on public.push_subscriptions to authenticated;

-- Registering the same browser/device again moves it to the current account.
create or replace function public.register_push_subscription(p_kind text, p_endpoint text, p_p256dh text, p_auth text, p_label text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = auth.uid()) >= 20
     and not exists (select 1 from public.push_subscriptions where endpoint = p_endpoint) then
    raise exception 'Too many devices. Remove an old one first.';
  end if;
  insert into public.push_subscriptions (user_id, kind, endpoint, p256dh, auth, device_label)
  values (auth.uid(), p_kind, p_endpoint, p_p256dh, p_auth, left(p_label, 100))
  on conflict (endpoint) do update
    set user_id = auth.uid(), kind = excluded.kind, p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = excluded.device_label, failures = 0, created_at = now()
  returning push_subscriptions.id into id;
  return id;
end;
$$;
revoke execute on function public.register_push_subscription(text, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;

create table if not exists public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  channel         text not null check (channel in ('email', 'push')),
  status          text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason          text check (reason is null or char_length(reason) <= 300),
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel)
);
create index if not exists deliveries_due_idx on public.notification_deliveries (next_attempt_at) where status = 'pending';
create index if not exists deliveries_user_idx on public.notification_deliveries (user_id, channel, sent_at);
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;
-- People can see what was sent to them (Settings → Notifications → recent deliveries).
drop policy if exists "own" on public.notification_deliveries;
create policy "own" on public.notification_deliveries for select to authenticated using (user_id = (select auth.uid()));
grant select (id, notification_id, channel, status, reason, sent_at, created_at) on public.notification_deliveries to authenticated;

create or replace function public.queue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.notification_prefs;
begin
  select * into p from public.notification_prefs where user_id = new.user_id and kind = new.kind;
  if new.kind = 'test' then
    -- "Send a test" from Settings: every channel the person has, straight away.
    insert into public.notification_deliveries (notification_id, user_id, channel, next_attempt_at)
    values (new.id, new.user_id, 'push', now()), (new.id, new.user_id, 'email', now())
    on conflict do nothing;
    return new;
  end if;
  if coalesce(p.push, false) then
    insert into public.notification_deliveries (notification_id, user_id, channel, next_attempt_at)
    values (new.id, new.user_id, 'push', now()) on conflict do nothing;
  end if;
  if coalesce(p.email, false) then
    insert into public.notification_deliveries (notification_id, user_id, channel, next_attempt_at)
    values (new.id, new.user_id, 'email', now() + interval '10 minutes') on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_deliver on public.notifications;
create trigger notifications_deliver after insert on public.notifications
  for each row execute function public.queue_notification_deliveries();

-- Where email goes: the institutional login address, or a verified recovery email.
create or replace function public.delivery_email(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select lower(u.email) from auth.users u where u.id = p_user and u.email not like '%@habitflow.local'),
    (select a.recovery_email from public.account_private a where a.user_id = p_user and a.email_verified_at is not null));
$$;
revoke execute on function public.delivery_email(uuid) from public, anon, authenticated;

-- Claims due deliveries for the sender (server only). Applies the skip rules,
-- leases each claimed row for 5 minutes (a crashed run is retried) and
-- returns what to send.
create or replace function public.delivery_claim(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d   record;
  out jsonb := '[]'::jsonb;
  em  text;
  subs jsonb;
begin
  for d in
    select x.*, n.kind, n.title, n.body, n.link, n.read_at, n.created_at n_created
      from public.notification_deliveries x join public.notifications n on n.id = x.notification_id
     where x.status = 'pending' and x.next_attempt_at <= now()
     order by x.next_attempt_at
     limit greatest(1, least(p_limit, 500))
     for update of x skip locked
  loop
    if d.n_created < now() - interval '2 days' then
      update public.notification_deliveries set status = 'skipped', reason = 'expired' where id = d.id;
      continue;
    end if;
    if d.channel = 'email' and d.kind <> 'test' then
      if d.read_at is not null then
        update public.notification_deliveries set status = 'skipped', reason = 'already read in the app' where id = d.id;
        continue;
      end if;
      if exists (select 1 from public.notification_deliveries p where p.notification_id = d.notification_id and p.channel = 'push' and p.status = 'sent') then
        update public.notification_deliveries set status = 'skipped', reason = 'delivered by push' where id = d.id;
        continue;
      end if;
      if (select count(*) from public.notification_deliveries e where e.user_id = d.user_id and e.channel = 'email'
           and e.status = 'sent' and e.sent_at > now() - interval '1 hour') >= 6 then
        update public.notification_deliveries set status = 'skipped', reason = 'email limit (6 per hour) — shown in the app' where id = d.id;
        continue;
      end if;
    end if;
    if d.channel = 'email' then
      em := public.delivery_email(d.user_id);
      if em is null then
        update public.notification_deliveries set status = 'skipped', reason = 'no email address' where id = d.id;
        continue;
      end if;
      subs := null;
    else
      em := null;
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
        into subs from public.push_subscriptions s where s.user_id = d.user_id;
      if jsonb_array_length(subs) = 0 then
        update public.notification_deliveries set status = 'skipped', reason = 'no devices' where id = d.id;
        continue;
      end if;
    end if;
    update public.notification_deliveries set attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes' where id = d.id;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', d.id, 'channel', d.channel, 'kind', d.kind, 'title', d.title, 'body', d.body, 'link', d.link,
      'attempt', d.attempts + 1, 'email', em, 'subscriptions', subs));
  end loop;
  return out;
end;
$$;
revoke execute on function public.delivery_claim(integer) from public, anon, authenticated;

-- Records the outcome. 'retry' backs off (1, 5, 30 minutes) and fails after 3 attempts.
create or replace function public.delivery_result(p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a smallint;
begin
  select attempts into a from public.notification_deliveries where id = p_id;
  if p_status = 'retry' then
    if a >= 3 then
      update public.notification_deliveries set status = 'failed', reason = left(p_reason, 300) where id = p_id;
    else
      update public.notification_deliveries set reason = left(p_reason, 300),
             next_attempt_at = now() + case a when 1 then interval '1 minute' when 2 then interval '5 minutes' else interval '30 minutes' end
       where id = p_id;
    end if;
  elsif p_status in ('sent', 'skipped', 'failed') then
    update public.notification_deliveries set status = p_status, reason = left(p_reason, 300),
           sent_at = case when p_status = 'sent' then now() end
     where id = p_id;
  else
    raise exception 'Unknown status';
  end if;
end;
$$;
revoke execute on function public.delivery_result(uuid, text, text) from public, anon, authenticated;

-- Push endpoint results: success resets failures; gone (404/410, unregistered) removes it.
create or replace function public.push_subscription_result(p_id uuid, p_ok boolean, p_gone boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_subscriptions where id = p_id and p_gone;
  update public.push_subscriptions
     set last_success_at = case when p_ok then now() else last_success_at end,
         failures = case when p_ok then 0 else failures + 1 end
   where id = p_id and not p_gone;
  delete from public.push_subscriptions where id = p_id and failures >= 10;
$$;
revoke execute on function public.push_subscription_result(uuid, boolean, boolean) from public, anon, authenticated;

-- Settings: what each channel can reach for me.
create or replace function public.my_notification_channels()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', public.delivery_email(auth.uid()),
    'institutional', exists (select 1 from auth.users u where u.id = auth.uid() and u.email not like '%@habitflow.local'),
    'devices', (select count(*) from public.push_subscriptions where user_id = auth.uid()));
$$;
revoke execute on function public.my_notification_channels() from public, anon;
grant execute on function public.my_notification_channels() to authenticated;

-- "Send a test notification" (at most 5 an hour).
create or replace function public.send_test_notification()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.notifications where user_id = auth.uid() and kind = 'test' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You can send 5 test notifications an hour.';
  end if;
  insert into public.notifications (user_id, kind, title, body, link)
  values (auth.uid(), 'test', 'Test notification', 'Notifications from HabitFlow reach you here.', '/settings');
end;
$$;
revoke execute on function public.send_test_notification() from public, anon;
grant execute on function public.send_test_notification() to authenticated;

-- Turning push off on a device (the app can't read endpoints, so it can't filter by them).
create or replace function public.unregister_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_subscriptions where user_id = auth.uid() and endpoint = p_endpoint;
$$;
revoke execute on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.unregister_push_subscription(text) to authenticated;
