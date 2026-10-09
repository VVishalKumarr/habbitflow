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
