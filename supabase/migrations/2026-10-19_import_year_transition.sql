-- =====================================================================
-- Phase 7 (part 2): CSV import and academic-year transition.
--
-- Import (needs the import_export permission, plus the normal permission for
-- each row — inviting students needs manage_students, staff manage_staff,
-- classes / subject teachers manage_classes in scope):
-- * people: one invitation per row through the institution-invite function;
--   the role is chosen in the app for the whole file — a role column in the
--   file is ignored. Students can be given a class: it's stored on the
--   invitation and the student is enrolled when they activate. People who
--   already have an account are enrolled (students) or skipped.
-- * classes, subject teachers: dry run (preview) and commit with the same
--   checks; invalid rows are skipped and reported; every import is logged.
-- Academic-year transition (principal/director): new current year; each
-- class promoted, repeated or graduated; students carried into the new
-- classes; old classes and year archived. Nothing is deleted.
-- Additive. Safe to re-run.
-- =====================================================================

alter table public.institution_invitations add column if not exists class_id uuid;
do $$ begin
  alter table public.institution_invitations add constraint institution_invitations_class_fkey
    foreign key (class_id, institution_id) references public.classes (id, institution_id) on delete set null (class_id);
exception when duplicate_object then null; end $$;

create table if not exists public.import_runs (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  kind           text not null check (kind in ('students', 'staff', 'classes', 'teaching')),
  file_name      text check (file_name is null or char_length(file_name) <= 200),
  actor_id       uuid references auth.users (id) on delete set null,
  total          integer not null default 0,
  created        integer not null default 0,
  skipped        integer not null default 0,
  failed         integer not null default 0,
  details        jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists import_runs_inst_idx on public.import_runs (institution_id, created_at desc);
alter table public.import_runs enable row level security;
revoke all on public.import_runs from anon, authenticated;
drop policy if exists "read" on public.import_runs;
create policy "read" on public.import_runs for select to authenticated using (public.has_inst_perm(institution_id, 'import_export'));
grant select on public.import_runs to authenticated;

-- Records an import (server-side callers pass the actor; the summary is also written to the audit log).
create or replace function public.record_import(p_actor uuid, p_inst uuid, p_kind text, p_file text, p_results jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  id uuid;
  c integer;
  s integer;
  f integer;
begin
  select count(*) filter (where r ->> 'status' = 'done'), count(*) filter (where r ->> 'status' = 'skip'),
         count(*) filter (where r ->> 'status' = 'error')
    into c, s, f from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r;
  insert into public.import_runs (institution_id, kind, file_name, actor_id, total, created, skipped, failed, details)
  values (p_inst, p_kind, left(p_file, 200), p_actor, jsonb_array_length(coalesce(p_results, '[]'::jsonb)), c, s, f,
          (select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r where r ->> 'status' <> 'done'))
  returning import_runs.id into id;
  insert into public.audit_log (institution_id, actor_id, action, record_type, record_id, new_value)
  values (p_inst, p_actor, 'import', 'import_' || p_kind, id::text,
          jsonb_build_object('file', p_file, 'total', c + s + f, 'created', c, 'skipped', s, 'failed', f));
  return id;
end;
$$;
revoke execute on function public.record_import(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- Can p_actor change this class's enrolment? (actor-based twin of can_manage_class, for server functions)
create or replace function public.actor_can_manage_class(p_actor uuid, p_class uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.classes;
  r text;
  mid uuid;
begin
  select * into c from public.classes where id = p_class;
  if c.id is null or c.archived or not public.has_inst_perm_for(p_actor, c.institution_id, 'manage_classes') then
    return false;
  end if;
  r := public.inst_role_for(p_actor, c.institution_id);
  if r in ('principal', 'director') then
    return true;
  end if;
  select id into mid from public.institution_memberships where institution_id = c.institution_id and user_id = p_actor and status = 'active';
  if r = 'coordinator' then
    return exists (select 1 from public.coordinator_scopes s where s.institution_id = c.institution_id and s.coordinator_id = mid
                    and (s.grade = '*' or lower(s.grade) = lower(c.grade)));
  end if;
  return c.class_teacher_id = mid;
end;
$$;
revoke execute on function public.actor_can_manage_class(uuid, uuid) from public, anon, authenticated;

-- A class by name (case-insensitive), preferring the current year; null if none / ambiguous.
create or replace function public.class_by_name(p_inst uuid, p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.classes c
    left join public.academic_years y on y.id = c.academic_year_id
   where c.institution_id = p_inst and not c.archived and lower(btrim(c.name)) = lower(btrim(p_name))
   order by coalesce(y.is_current, false) desc, c.created_at desc
   limit 1;
$$;
revoke execute on function public.class_by_name(uuid, text) from public, anon, authenticated;

-- An active staff member by login email or staff number.
create or replace function public.staff_by_ref(p_inst uuid, p_ref text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from public.institution_memberships m
    left join auth.users u on u.id = m.user_id
   where m.institution_id = p_inst and m.status = 'active' and public.is_staff_role(m.role)
     and (lower(u.email) = lower(btrim(p_ref)) or lower(m.external_id) = lower(btrim(p_ref)))
   limit 1;
$$;
revoke execute on function public.staff_by_ref(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
-- What would happen to one row. {status: ok|skip|error, action: invite|enrol|none, messages[], class_id}
create or replace function public.import_person_check(p_actor uuid, p_inst uuid, p_role text, p_email text, p_name text, p_external_id text, p_class text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  em   text := lower(btrim(coalesce(p_email, '')));
  errs text[] := '{}';
  warn text[] := '{}';
  cls  uuid;
  mem  public.institution_memberships;
begin
  if not (public.is_platform_admin_user(p_actor) or public.has_inst_perm_for(p_actor, p_inst, 'import_export')) then
    return jsonb_build_object('status', 'error', 'action', 'none', 'messages', jsonb_build_array('You don’t have permission to import.'));
  end if;
  if p_role not in ('coordinator', 'class_teacher', 'subject_teacher', 'student') then
    return jsonb_build_object('status', 'error', 'action', 'none', 'messages', jsonb_build_array('Choose students or a staff role to import.'));
  end if;
  if not public.can_invite_role(p_actor, p_inst, p_role) then
    return jsonb_build_object('status', 'error', 'action', 'none', 'messages', jsonb_build_array('You are not allowed to invite this role.'));
  end if;
  if em !~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(em) > 254 then
    errs := array_append(errs, 'Invalid email address.');
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    errs := array_append(errs, 'Name is required (up to 80 characters).');
  end if;
  if p_external_id is not null and char_length(btrim(p_external_id)) > 40 then
    errs := array_append(errs, 'Admission / staff number is longer than 40 characters.');
  end if;
  if coalesce(btrim(p_class), '') <> '' then
    if p_role <> 'student' then
      warn := array_append(warn, 'Class ignored for staff (assign classes after they join).');
    else
      cls := public.class_by_name(p_inst, p_class);
      if cls is null then
        errs := array_append(errs, format('Class “%s” not found.', btrim(p_class)));
      elsif not public.actor_can_manage_class(p_actor, cls) then
        errs := array_append(errs, format('You can’t enrol students in %s.', btrim(p_class)));
      end if;
    end if;
  end if;
  if em ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$' then
    select m.* into mem from public.institution_memberships m join auth.users u on u.id = m.user_id
     where m.institution_id = p_inst and lower(u.email) = em;
    if mem.id is null and not public.email_allowlisted(p_inst, em, false) then
      errs := array_append(errs, 'Email isn’t on the institution’s approved list.');
    end if;
  end if;
  if p_external_id is not null and btrim(p_external_id) <> '' and exists (
       select 1 from public.institution_memberships m where m.institution_id = p_inst and lower(m.external_id) = lower(btrim(p_external_id))
          and (mem.id is null or m.id <> mem.id)) then
    errs := array_append(errs, 'This admission / staff number belongs to someone else.');
  end if;
  if array_length(errs, 1) > 0 then
    return jsonb_build_object('status', 'error', 'action', 'none', 'messages', to_jsonb(errs || warn));
  end if;
  if mem.id is not null then
    if mem.role = 'student' and p_role = 'student' and cls is not null and mem.status = 'active'
       and not exists (select 1 from public.class_enrollments e where e.class_id = cls and e.student_id = mem.id) then
      return jsonb_build_object('status', 'ok', 'action', 'enrol', 'class_id', cls,
                                'messages', to_jsonb(array['Already has an account — will be enrolled in the class.'] || warn));
    end if;
    return jsonb_build_object('status', 'skip', 'action', 'none', 'messages', to_jsonb(array['Already has an account at this institution.'] || warn));
  end if;
  if exists (select 1 from public.institution_invitations i where i.institution_id = p_inst and i.email = em and i.status = 'pending') then
    warn := array_append(warn, 'Replaces a pending invitation.');
  end if;
  return jsonb_build_object('status', 'ok', 'action', 'invite', 'class_id', cls, 'messages', to_jsonb(warn));
end;
$$;
revoke execute on function public.import_person_check(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

-- Preview for the app: every row checked, plus duplicates inside the file.
create or replace function public.import_check_people(p_inst uuid, p_role text, p_rows jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r      jsonb;
  i      integer := 0;
  res    jsonb;
  out    jsonb := '[]'::jsonb;
  emails text[] := '{}';
  ids    text[] := '{}';
  em     text;
  ext    text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'INVALID_IMPORT:Up to 2,000 rows per file.' using errcode = 'P0001';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    em := lower(btrim(coalesce(r ->> 'email', '')));
    ext := lower(btrim(coalesce(r ->> 'external_id', '')));
    if em <> '' and em = any (emails) then
      res := jsonb_build_object('status', 'error', 'action', 'none', 'messages', jsonb_build_array('Duplicate email in this file.'));
    elsif ext <> '' and ext = any (ids) then
      res := jsonb_build_object('status', 'error', 'action', 'none', 'messages', jsonb_build_array('Duplicate admission / staff number in this file.'));
    else
      res := public.import_person_check(auth.uid(), p_inst, p_role, r ->> 'email', r ->> 'name', nullif(r ->> 'external_id', ''), r ->> 'class');
    end if;
    emails := array_append(emails, em);
    if ext <> '' then ids := array_append(ids, ext); end if;
    out := out || jsonb_build_array(res || jsonb_build_object('row', i));
  end loop;
  return out;
end;
$$;
revoke execute on function public.import_check_people(uuid, text, jsonb) from public, anon;
grant execute on function public.import_check_people(uuid, text, jsonb) to authenticated;

-- One row for real (server only; the institution-invite function sends the email).
create or replace function public.import_person(p_actor uuid, p_inst uuid, p_role text, p_email text, p_name text, p_external_id text, p_class text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  chk jsonb := public.import_person_check(p_actor, p_inst, p_role, p_email, p_name, nullif(btrim(coalesce(p_external_id, '')), ''), p_class);
  mid uuid;
  inv jsonb;
begin
  perform set_config('habitflow.actor', p_actor::text, true);
  if chk ->> 'status' = 'error' then
    return jsonb_build_object('status', 'error', 'messages', chk -> 'messages');
  end if;
  if chk ->> 'status' = 'skip' then
    return jsonb_build_object('status', 'skip', 'messages', chk -> 'messages');
  end if;
  if chk ->> 'action' = 'enrol' then
    select m.id into mid from public.institution_memberships m join auth.users u on u.id = m.user_id
     where m.institution_id = p_inst and lower(u.email) = lower(btrim(p_email));
    insert into public.class_enrollments (institution_id, class_id, student_id) values (p_inst, (chk ->> 'class_id')::uuid, mid)
    on conflict do nothing;
    return jsonb_build_object('status', 'done', 'action', 'enrolled', 'messages', chk -> 'messages');
  end if;
  inv := public.create_invitation(p_actor, p_inst, p_email, p_role, p_name, nullif(btrim(coalesce(p_external_id, '')), ''), p_token_hash);
  if chk ->> 'class_id' is not null then
    update public.institution_invitations set class_id = (chk ->> 'class_id')::uuid where id = (inv ->> 'id')::uuid;
  end if;
  return jsonb_build_object('status', 'done', 'action', 'invited', 'invite', inv, 'messages', chk -> 'messages');
end;
$$;
revoke execute on function public.import_person(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;

-- Activation enrols a student in the class chosen at import.
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
  if inv.class_id is not null and inv.role = 'student'
     and exists (select 1 from public.classes c where c.id = inv.class_id and not c.archived) then
    insert into public.class_enrollments (institution_id, class_id, student_id) values (inv.institution_id, inv.class_id, mid)
    on conflict do nothing;
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
  if inv.class_id is not null and inv.role = 'student'
     and exists (select 1 from public.classes c where c.id = inv.class_id and not c.archived) then
    insert into public.class_enrollments (institution_id, class_id, student_id) values (inv.institution_id, inv.class_id, mid)
    on conflict do nothing;
  end if;
  return jsonb_build_object('institution_id', inv.institution_id, 'membership_id', mid);
end;
$$;
revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------
-- Classes: rows {name, grade, section?, class_teacher?} (teacher = email or staff number)
-- ---------------------------------------------------------------------
create or replace function public.import_classes(p_inst uuid, p_rows jsonb, p_commit boolean default false, p_file text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me    uuid := auth.uid();
  r     jsonb;
  i     integer := 0;
  out   jsonb := '[]'::jsonb;
  errs  text[];
  warn  text[];
  nm    text;
  gr    text;
  sec   text;
  tch   uuid;
  names text[] := '{}';
  yr    uuid := (select id from public.academic_years where institution_id = p_inst and is_current);
  st    text;
begin
  if me is null or not public.has_inst_perm(p_inst, 'import_export') then
    raise exception 'NOT_ALLOWED:You don’t have permission to import.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'INVALID_IMPORT:Up to 500 classes per file.' using errcode = 'P0001';
  end if;
  perform set_config('habitflow.actor', me::text, true);
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    errs := '{}';
    warn := '{}';
    tch := null;
    nm := btrim(coalesce(r ->> 'name', ''));
    gr := btrim(coalesce(r ->> 'grade', ''));
    sec := nullif(btrim(coalesce(r ->> 'section', '')), '');
    if char_length(nm) not between 1 and 60 then errs := array_append(errs, 'Class name is required (up to 60 characters).'); end if;
    if char_length(gr) not between 1 and 30 then errs := array_append(errs, 'Grade is required (up to 30 characters).'); end if;
    if sec is not null and char_length(sec) > 20 then errs := array_append(errs, 'Section is longer than 20 characters.'); end if;
    if gr <> '' and not public.can_manage_grade(p_inst, gr) then errs := array_append(errs, format('You can’t create classes in grade %s.', gr)); end if;
    if coalesce(btrim(r ->> 'class_teacher'), '') <> '' then
      tch := public.staff_by_ref(p_inst, r ->> 'class_teacher');
      if tch is null then errs := array_append(errs, format('Class teacher “%s” not found among active staff.', btrim(r ->> 'class_teacher'))); end if;
    end if;
    if nm <> '' and lower(nm) = any (names) then
      st := 'error'; errs := array_append(errs, 'Duplicate class name in this file.');
    end if;
    if array_length(errs, 1) > 0 then
      st := 'error';
    elsif public.class_by_name(p_inst, nm) is not null then
      st := 'skip'; warn := array_append(warn, 'A class with this name already exists.');
    else
      st := case when p_commit then 'done' else 'ok' end;
      if p_commit then
        insert into public.classes (institution_id, academic_year_id, grade, section, name, class_teacher_id)
        values (p_inst, yr, gr, sec, nm, tch);
      end if;
    end if;
    names := array_append(names, lower(nm));
    out := out || jsonb_build_array(jsonb_build_object('row', i, 'status', st, 'action', 'create', 'messages', to_jsonb(errs || warn)));
  end loop;
  if p_commit then
    perform public.record_import(me, p_inst, 'classes', p_file, out);
  end if;
  return out;
end;
$$;
revoke execute on function public.import_classes(uuid, jsonb, boolean, text) from public, anon;
grant execute on function public.import_classes(uuid, jsonb, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Subject teachers: rows {class, subject, teacher}; unknown subjects are created.
-- ---------------------------------------------------------------------
create or replace function public.import_teaching(p_inst uuid, p_rows jsonb, p_commit boolean default false, p_file text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me   uuid := auth.uid();
  r    jsonb;
  i    integer := 0;
  out  jsonb := '[]'::jsonb;
  errs text[];
  warn text[];
  cls  uuid;
  sbj  uuid;
  tch  uuid;
  sn   text;
  seen text[] := '{}';
  key  text;
  st   text;
begin
  if me is null or not public.has_inst_perm(p_inst, 'import_export') then
    raise exception 'NOT_ALLOWED:You don’t have permission to import.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'INVALID_IMPORT:Up to 2,000 rows per file.' using errcode = 'P0001';
  end if;
  perform set_config('habitflow.actor', me::text, true);
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    errs := '{}';
    warn := '{}';
    cls := public.class_by_name(p_inst, coalesce(r ->> 'class', ''));
    sn := btrim(coalesce(r ->> 'subject', ''));
    tch := case when coalesce(btrim(r ->> 'teacher'), '') <> '' then public.staff_by_ref(p_inst, r ->> 'teacher') end;
    sbj := (select id from public.subjects where institution_id = p_inst and lower(name) = lower(sn));
    if cls is null then errs := array_append(errs, format('Class “%s” not found.', btrim(coalesce(r ->> 'class', '')))); end if;
    if cls is not null and not public.can_manage_class(cls) then errs := array_append(errs, 'You can’t change this class.'); end if;
    if char_length(sn) not between 1 and 80 then errs := array_append(errs, 'Subject is required (up to 80 characters).'); end if;
    if tch is null then errs := array_append(errs, format('Teacher “%s” not found among active staff.', btrim(coalesce(r ->> 'teacher', '')))); end if;
    if sbj is null and sn <> '' then warn := array_append(warn, format('New subject “%s” will be created.', sn)); end if;
    key := coalesce(cls::text, '') || '|' || lower(sn) || '|' || coalesce(tch::text, '');
    if array_length(errs, 1) > 0 then
      st := 'error';
    elsif key = any (seen) then
      st := 'error'; errs := array_append(errs, 'Duplicate row in this file.');
    elsif sbj is not null and exists (select 1 from public.teaching_assignments t where t.class_id = cls and t.subject_id = sbj and t.teacher_id = tch) then
      st := 'skip'; warn := array['Already assigned.'];
    else
      st := case when p_commit then 'done' else 'ok' end;
      if p_commit then
        if sbj is null then
          insert into public.subjects (institution_id, name) values (p_inst, sn) returning id into sbj;
        end if;
        insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id) values (p_inst, cls, sbj, tch)
        on conflict do nothing;
      end if;
    end if;
    seen := array_append(seen, key);
    out := out || jsonb_build_array(jsonb_build_object('row', i, 'status', st, 'action', 'assign', 'messages', to_jsonb(errs || warn)));
  end loop;
  if p_commit then
    perform public.record_import(me, p_inst, 'teaching', p_file, out);
  end if;
  return out;
end;
$$;
revoke execute on function public.import_teaching(uuid, jsonb, boolean, text) from public, anon;
grant execute on function public.import_teaching(uuid, jsonb, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Academic-year transition
-- ---------------------------------------------------------------------
create or replace function public.year_transition_preview(p_inst uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  y public.academic_years;
  top integer;
begin
  if coalesce(public.inst_role(p_inst), '') not in ('principal', 'director') then
    raise exception 'NOT_ALLOWED:Only the principal or director can start a new academic year.' using errcode = '42501';
  end if;
  select * into y from public.academic_years where institution_id = p_inst and is_current;
  select max(case when c.grade ~ '^\d{1,2}$' then c.grade::integer end) into top from public.classes c
   where c.institution_id = p_inst and not c.archived;
  return jsonb_build_object(
    'year', case when y.id is null then null else jsonb_build_object('id', y.id, 'name', y.name, 'starts_on', y.starts_on, 'ends_on', y.ends_on) end,
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'grade', c.grade, 'section', c.section,
        'students', (select count(*) from public.class_enrollments e join public.institution_memberships m on m.id = e.student_id
                      where e.class_id = c.id and m.status = 'active'),
        'class_teacher', (select display_name from public.institution_memberships where id = c.class_teacher_id),
        'suggested_action', case when c.grade ~ '^\d{1,2}$' and c.grade::integer = top then 'graduate'
                                 when c.grade ~ '^\d{1,2}$' then 'promote' else 'repeat' end,
        'suggested_grade', case when c.grade ~ '^\d{1,2}$' then (c.grade::integer + 1)::text else c.grade end,
        'suggested_name', case when c.grade ~ '^\d{1,2}$' and c.name ~ ('^' || c.grade || '(\D|$)')
                               then regexp_replace(c.name, '^' || c.grade, (c.grade::integer + 1)::text)
                               else c.name end
      ) order by c.grade, c.name)
      from public.classes c
     where c.institution_id = p_inst and not c.archived
       and (y.id is null or c.academic_year_id is null or c.academic_year_id = y.id)), '[]'::jsonb));
end;
$$;
revoke execute on function public.year_transition_preview(uuid) from public, anon;
grant execute on function public.year_transition_preview(uuid) to authenticated;

-- p_plan: [{class_id, action: promote|repeat|graduate, grade?, name?}] — every class in the preview must be listed.
create or replace function public.year_transition(p_inst uuid, p_name text, p_starts date, p_ends date, p_plan jsonb, p_copy_teachers boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      uuid := auth.uid();
  old     public.academic_years;
  new_id  uuid;
  item    jsonb;
  c       public.classes;
  new_cls uuid;
  n_cls   integer := 0;
  n_moved integer := 0;
  n_grad  integer := 0;
  n_arch  integer := 0;
  act     text;
  ids     uuid[];
  moved   integer;
begin
  if me is null or coalesce(public.inst_role(p_inst), '') not in ('principal', 'director') then
    raise exception 'NOT_ALLOWED:Only the principal or director can start a new academic year.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 40 then
    raise exception 'INVALID_TRANSITION:Give the new year a name (up to 40 characters).' using errcode = 'P0001';
  end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts or p_ends - p_starts > 800 then
    raise exception 'INVALID_TRANSITION:Check the start and end dates.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.academic_years where institution_id = p_inst and lower(name) = lower(btrim(p_name))) then
    raise exception 'INVALID_TRANSITION:A year with this name already exists.' using errcode = 'P0001';
  end if;
  select * into old from public.academic_years where institution_id = p_inst and is_current for update;
  if old.id is not null and p_starts <= old.starts_on then
    raise exception 'INVALID_TRANSITION:The new year must start after the current one.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_plan) <> 'array' then
    raise exception 'INVALID_TRANSITION:Missing plan.' using errcode = 'P0001';
  end if;
  select array_agg((x ->> 'class_id')::uuid) into ids from jsonb_array_elements(p_plan) x;
  if exists (select 1 from public.classes k where k.institution_id = p_inst and not k.archived
               and (old.id is null or k.academic_year_id is null or k.academic_year_id = old.id)
               and not (k.id = any (coalesce(ids, '{}')))) then
    raise exception 'INVALID_TRANSITION:Choose what happens to every class.' using errcode = 'P0001';
  end if;

  perform set_config('habitflow.actor', me::text, true);
  perform set_config('habitflow.audit_reason', 'Academic-year transition to ' || btrim(p_name), true);
  if old.id is not null then
    update public.academic_years set is_current = false, archived = true where id = old.id;
  end if;
  insert into public.academic_years (institution_id, name, starts_on, ends_on, is_current)
  values (p_inst, btrim(p_name), p_starts, p_ends, true) returning id into new_id;

  for item in select value from jsonb_array_elements(p_plan) loop
    select * into c from public.classes k where k.id = (item ->> 'class_id')::uuid and k.institution_id = p_inst and not k.archived;
    if c.id is null then
      raise exception 'INVALID_TRANSITION:Unknown class in the plan.' using errcode = 'P0001';
    end if;
    act := item ->> 'action';
    if act not in ('promote', 'repeat', 'graduate') then
      raise exception 'INVALID_TRANSITION:Unknown action for %.', c.name using errcode = 'P0001';
    end if;
    if act = 'promote' and (char_length(btrim(coalesce(item ->> 'grade', ''))) not between 1 and 30
                            or char_length(btrim(coalesce(item ->> 'name', ''))) not between 1 and 60) then
      raise exception 'INVALID_TRANSITION:Give % a new grade and name.', c.name using errcode = 'P0001';
    end if;
    if act in ('promote', 'repeat') then
      insert into public.classes (institution_id, academic_year_id, grade, section, name, class_teacher_id)
      values (p_inst, new_id,
              case when act = 'promote' then btrim(coalesce(item ->> 'grade', '')) else c.grade end,
              c.section,
              case when act = 'promote' then btrim(coalesce(item ->> 'name', '')) else c.name end,
              case when p_copy_teachers then c.class_teacher_id end)
      returning id into new_cls;
      n_cls := n_cls + 1;
      insert into public.class_enrollments (institution_id, class_id, student_id, roll_no)
      select p_inst, new_cls, e.student_id, e.roll_no
        from public.class_enrollments e join public.institution_memberships m on m.id = e.student_id
       where e.class_id = c.id and m.status = 'active';
      get diagnostics moved = row_count;
      n_moved := n_moved + moved;
      if p_copy_teachers then
        insert into public.teaching_assignments (institution_id, class_id, subject_id, teacher_id)
        select p_inst, new_cls, t.subject_id, t.teacher_id from public.teaching_assignments t
          join public.institution_memberships m on m.id = t.teacher_id
         where t.class_id = c.id and m.status = 'active';
      end if;
    else
      n_grad := n_grad + (select count(*) from public.class_enrollments e join public.institution_memberships m on m.id = e.student_id
                           where e.class_id = c.id and m.status = 'active');
    end if;
    update public.classes set archived = true where id = c.id;
    n_arch := n_arch + 1;
  end loop;

  insert into public.audit_log (institution_id, actor_id, action, record_type, record_id, new_value)
  values (p_inst, me, 'transition', 'academic_year', new_id::text,
          jsonb_build_object('name', btrim(p_name), 'from_year', old.name, 'new_classes', n_cls, 'students_moved', n_moved,
                             'graduated', n_grad, 'archived_classes', n_arch));
  return jsonb_build_object('year_id', new_id, 'new_classes', n_cls, 'students_moved', n_moved, 'graduated', n_grad, 'archived_classes', n_arch);
end;
$$;
revoke execute on function public.year_transition(uuid, text, date, date, jsonb, boolean) from public, anon;
grant execute on function public.year_transition(uuid, text, date, date, jsonb, boolean) to authenticated;
