-- =====================================================================
-- Email one-time codes: log in with a 6-digit code instead of a password,
-- and confirm email addresses with a code instead of a link.
--
-- * login_codes: one row per code request. Only the SHA-256 hash of the
--   code is stored; codes expire after 10 minutes, allow 5 attempts and
--   work once. Server functions only (no client access at all).
-- * account_private.pending_attempts: wrong-code counter for confirming a
--   new email address (5 attempts, then a new code is needed).
-- The login itself still goes through Supabase Auth (a one-time sign-in
-- token is issued only after the code is checked), so existing accounts,
-- passwords and institutional logins keep working unchanged.
-- Safe to re-run.
-- =====================================================================
create table if not exists public.login_codes (
  id           uuid primary key default gen_random_uuid(),
  destination  text not null check (char_length(destination) <= 254),
  user_ids     uuid[] not null default '{}',
  code_hash    text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts     smallint not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists login_codes_created_idx on public.login_codes (created_at);
alter table public.login_codes enable row level security;
revoke all on public.login_codes from anon, authenticated;

alter table public.account_private add column if not exists pending_attempts smallint not null default 0;

-- my_account(): also report when the account was created and its type, so the
-- app can ask existing users for an email with a grace period.
create or replace function public.my_account()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'username', p.username,
    'account_type', p.account_type,
    'created_at', p.created_at,
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

-- Who may receive a login code for an identifier (server functions only).
-- * a username: that personal account, if it has a verified email;
-- * an email: personal accounts with that verified email, and the
--   institutional account that signs in with that address.
-- Banned users are never returned.
create or replace function public.login_code_accounts(p_identifier text)
returns table (user_id uuid, username text, login_email text, destination text)
language sql
stable
security definer
set search_path = ''
as $$
  with id as (select lower(btrim(coalesce(p_identifier, ''))) v)
  select p.id, p.username, u.email::text, a.recovery_email
    from id, public.profiles p
    join public.account_private a on a.user_id = p.id and a.email_verified_at is not null and a.recovery_email is not null
    join auth.users u on u.id = p.id and (u.banned_until is null or u.banned_until < now())
   where (position('@' in id.v) = 0 and p.username = id.v)
      or (position('@' in id.v) > 0 and a.recovery_email = id.v)
  union
  select p.id, p.username, u.email::text, lower(u.email)
    from id, auth.users u
    join public.profiles p on p.id = u.id
   where position('@' in id.v) > 0 and lower(u.email) = id.v and u.email not like '%@habitflow.local'
     and (u.banned_until is null or u.banned_until < now());
$$;
revoke execute on function public.login_code_accounts(text) from public, anon, authenticated;
grant execute on function public.login_code_accounts(text) to service_role;
