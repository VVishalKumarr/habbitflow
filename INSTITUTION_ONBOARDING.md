# Onboarding an institution

## 0. One-time: make yourself platform owner

The platform owner role is granted only with SQL (there is no button for it, so it
can’t be granted by mistake or by an attacker). Sign up a normal HabbitFlow account
for yourself first, then run (Supabase dashboard → SQL editor, or
`node --env-file=.env scripts/db-apply.mjs --query "…"`):

```sql
insert into public.platform_admins (user_id, note)
select id, 'owner' from public.profiles where username = 'your-username';
```

After you log in again, the account menu shows **Platform admin** (`/admin`).
To remove it: `delete from public.platform_admins where user_id = '…';`

## 1. Create the institution

**Platform admin → New institution**: name, type, time zone.

## 2. Approve email addresses

On the institution’s page add entries to **Approved email addresses and domains**:

- **Exact address** (`principal@school.edu`) — required for principals and directors.
- **Domain** (`school.edu`) — lets the institution invite any staff or student
  address on that domain. A domain never makes anyone a principal or director.
  Public providers (gmail.com, outlook.com…) can’t be approved as domains; add those
  people’s exact addresses instead.

Entries can be revoked later; existing accounts keep working, new invitations to
that address/domain are refused.

Without the UI (e.g. bulk after signing a contract):

```sql
insert into public.institution_email_allowlist (institution_id, kind, value, note)
values ('<institution id>', 'domain', 'school.edu', 'Contract 2026-14'),
       ('<institution id>', 'email', 'principal@school.edu', 'Head');
```

## 3. Invite the principal or director

**Invite principal / director** → name, exact approved email, role. They receive an
email with a one-time link (7 days). Opening it confirms their address; they choose a
password and land in **School**. From then on they sign in at
**Log in → Institution** with that email and password.

- Links are 32 random bytes, stored only as a SHA-256 hash, work once, and stop
  working when resent or withdrawn.
- Passwords are never emailed or stored by HabbitFlow (Supabase Auth hashes them).
- An address that already has a HabbitFlow institutional account (e.g. a teacher at
  two institutions) is asked to sign in and accept instead.

### Before email is configured

Until `RESEND_API_KEY` and `EMAIL_FROM` are set, invitations can’t be emailed. While
the `ALLOW_MANUAL_INVITE_LINKS=true` function secret is set, the inviter instead sees
the one-time link to deliver privately (anyone with the link can activate that
account). As soon as email is configured, links are emailed and no longer shown. To
turn manual links off before then:

```bash
npx supabase secrets unset ALLOW_MANUAL_INVITE_LINKS --project-ref <ref>
```

## 4. The principal sets up the school

1. **School → Settings**: academic year and terms, branding, grading scale,
   workload limits, homework retention (0–14 days), role permissions.
2. **Classes & subjects**: subjects, classes (grade + section), class teachers.
3. **People → Invite**: coordinators, class teachers, subject teachers, students
   (addresses must be approved). Then set each coordinator’s grades.
4. **Classes & subjects**: assign subject teachers to classes and enrol students.

## Suspending, removing, password resets

- **People → Suspend / Remove** (reason required, kept in the audit history). The
  person is signed out everywhere and loses access immediately; records stay.
  **Reactivate** restores access with the same role.
- **Platform admin → Suspend institution** blocks every member until reactivated; no
  data is deleted.
- Forgotten passwords: **Forgot password** with the institutional email (needs email
  configured). Staff can also resend an unused invitation.
