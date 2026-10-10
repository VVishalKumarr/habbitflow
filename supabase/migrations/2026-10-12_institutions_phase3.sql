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
