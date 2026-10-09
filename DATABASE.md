# Database

Postgres on Supabase. Full schema: `supabase/schema.sql` (idempotent).
Incremental changes: `supabase/migrations/` (apply the newest to an existing project).
Every table has Row Level Security (RLS); the browser only ever uses the public key.

## Tables

| Table | Rows | Who can read | Who can write |
| --- | --- | --- | --- |
| `profiles` | one per user: username, preferences, `accent_theme`, `share_progress`, `leaderboard_opt_in` | own row | own preference columns only; username only via `change_username()` |
| `trackers`, `time_slots`, `tasks`, `task_completions` | timetable data | own rows | own rows (composite FKs stop cross-user links) |
| `pomodoro_sessions` | focus sessions | own | own (insert/delete) |
| `friendships` | one row per pair, `pending`/`accepted` | both parties | delete by either party; create/accept only via functions |
| `plans` | `free`, `pro`: prices, limits, features, provider product ids | everyone | nobody (SQL/dashboard only) |
| `subscriptions` | one per purchase/trial | own rows | **server only** (webhooks, verification, `start_trial()`) |
| `account_private` | recovery email, pending email + token hash | nobody directly (`my_account()`) | server functions / security-definer RPCs |
| `rate_events` | short-lived counters (password attempts, requests) | nobody | security-definer functions; rows expire after a day |

Deleting a user (`auth.users`) cascades to everything they own.

## Plans, limits and entitlements

`plans.limits` (JSON, `null` = unlimited) and `plans.features` (text[]) drive everything:

```sql
select id, price_monthly, price_yearly, trial_days, limits, features from public.plans;
```

Server helpers (not callable from the browser): `plan_of(user)`, `plan_limit(user, key)`,
`has_feature(user, feature)`. A user is Pro when a `subscriptions` row has
`plan='pro'` and status `active`/`trialing`/`past_due` (not expired) or `cancelled`
with `expires_at` in the future.

Enforced in the database:

- `trackers` insert trigger → `PLAN_LIMIT:trackers:N`
- `send_friend_request` / `respond_friend_request` → `PLAN_LIMIT:friends:N`
  (accepted friends + requests you sent)
- `profiles.accent_theme` change → `PRO_REQUIRED:custom_themes`
- `compare_progress` longer than `history_days` → `PRO_REQUIRED:advanced_statistics`
- `export_timetable` → `PRO_REQUIRED:csv_export`
- `friends_leaderboard` → `PRO_REQUIRED:leaderboards`

Limits never delete or hide existing data; they only block new items.

`my_entitlements()` returns `{ plan, state: FREE|PRO|TRIAL|EXPIRED, limits, features, … }`
for the UI. `start_trial()` grants one trial per account if `plans.trial_days > 0`.

## RPC functions (callable by signed-in users)

| Function | Purpose |
| --- | --- |
| `my_entitlements()`, `start_trial()` | plan state, one free trial |
| `my_account()` | username, recovery email status |
| `check_password(pw)` | verifies current password (bcrypt); 5 failures / 15 min → locked |
| `change_username(new, pw)` | renames the same account (profile + login address) |
| `remove_recovery_email(pw)`, `cancel_pending_email()` | manage recovery email |
| `confirm_recovery_email(token)` | also callable signed-out; one-time, 24 h |
| `delete_account_confirmed(pw)` | fallback deletion when the server function isn’t deployed |
| `send_friend_request`, `respond_friend_request`, `list_friends` | friends |
| `compare_progress(friend, from, to, tz)` | daily totals for you + a friend who shares |
| `friends_leaderboard(tz)` | last-7-day totals for you + opted-in friends |
| `export_timetable(from, to, tz)` | Pro export rows (own data only) |
| `delete_account()` | legacy (older app versions) |

## Institutions (Phase 1)

Migration: `supabase/migrations/2026-10-10_institutions_phase1.sql` (also appended to
`schema.sql`). Apply with `node --env-file=.env scripts/db-apply.mjs <file>`; it is
additive and safe to re-run. Roles and permissions: [ROLE_PERMISSIONS.md](ROLE_PERMISSIONS.md).

| Table | Purpose |
|---|---|
| `platform_admins` | platform owner accounts (granted with SQL only) |
| `institutions` | name, type, status, time zone, branding, `settings` (retention ≤ 14 days, workload limits, grading scale, attendance statuses — validated by trigger) |
| `institution_email_allowlist` | approved exact emails / domains per institution |
| `institution_invitations` | pending/accepted/revoked invitations; `token_hash` is never readable by clients |
| `institution_memberships` | one per person per institution: role, status (active/suspended/revoked), name, admission/staff number |
| `institution_role_permissions` | per-institution permission overrides for coordinator / class teacher / subject teacher |
| `academic_years`, `terms` | academic calendar structure (one current year) |
| `subjects`, `classes` | archived, never deleted |
| `class_enrollments`, `teaching_assignments`, `coordinator_scopes` | who is in / teaches / coordinates what |
| `calendar_events` | exams, holidays, events, workshops, programmes, PTMs — institution-wide, per grade or per class |
| `assignments` | homework/classwork/projects with `opens_at`/`due_at` (window ≤ 1 calendar month, checked by constraint), allowed file types, retention days |
| `deadline_change_requests` | proposed deadline moves, applied only on approval |
| `audit_log` | append-only history (insert/update/delete with old/new values, actor, reason) |

Every institution-owned row has `institution_id`; composite foreign keys
`(id, institution_id)` make cross-institution references impossible and a trigger
stops rows moving between institutions.

Key functions: `my_institutions()`, `my_permissions(inst)`, `institution_overview(inst)`,
`deadline_calendar(inst, from, to, class?, grade?, subject?, teacher?)` (conflict flags:
`overlapping_deadlines`, `heavy_day`, `heavy_week`, `exam_conflict`, `multiple_exams`,
`holiday`), `set_member_status`, `update_member`, `revoke_invitation`,
`accept_invitation`, `set_homework_retention`, `decide_deadline_change`,
`platform_create_institution`, `platform_set_institution_status`,
`platform_institutions`. Server-only: `create_invitation`, `rotate_invitation`,
`invitation_preview`, `institutional_login_exists`.

Sign-up triggers on `auth.users`: `before_new_user` (institutional accounts need a
valid one-time activation token, which it strips from the metadata) and
`handle_new_user` (creates the profile and membership); `guard_email_change` stops
login addresses being changed through the Auth API.
