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
  ('plus', 'Plus', 1, 5900, 49900, 0,
   '{"trackers": null, "friends": 10, "history_days": null}',
   array['basic_statistics', 'unlimited_trackers', 'advanced_statistics', 'full_history', 'custom_themes', 'no_ads'])
on conflict (id) do nothing;

update public.plans set rank = 0 where id = 'free';
update public.plans set rank = 1 where id = 'plus';
update public.plans set rank = 2 where id = 'pro';

-- Seed regional prices only where none are set yet.
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 0, "yearly": 0}, "default": {"currency": "USD", "monthly": 0, "yearly": 0}}'
  where id = 'free' and prices = '{}'::jsonb;
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 5900, "yearly": 49900}, "default": {"currency": "USD", "monthly": 249, "yearly": 1999}}'
  where id = 'plus' and prices = '{}'::jsonb;
update public.plans set prices = '{"IN": {"currency": "INR", "monthly": 12900, "yearly": 99900}, "default": {"currency": "USD", "monthly": 499, "yearly": 3999}}'
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
