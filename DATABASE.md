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

### Phase 2 (`2026-10-11_institutions_phase2.sql`)

| Table | Purpose |
|---|---|
| `submissions` | one per student per assignment: status (not submitted → submitted → under review → accepted / resubmission requested / rejected), attempt, timestamps, late flag, feedback |
| `submission_files` | uploaded files (path in the private `homework` bucket, type, size, SHA-256); `deleted_at` once removed |
| `submission_reviews` | review history (status, comment, attempt, reviewer) |
| `homework_file_deletions` | minimal record of each file deleted by the retention job |
| `attendance_records` | per student per class/date/period (and subject for subject sessions); corrections carry a reason |
| `assessments`, `marks` | internal/external/project/practical assessments with max marks; marks 0..max or absent; draft → published |
| `notifications` | in-app notifications (dedupe key per user) |

No client role can write submissions, files, reviews, attendance or marks directly:
`homework_*` functions (server only), `review_submission`, `record_attendance`,
`save_marks`, `publish_assessment`, `set_retention_hold`. Read models:
`academic_summary(inst, class?, days)`, `assignment_progress(ids[])`, `grade_for(inst, pct)`.
Scheduled job: see [HOMEWORK_RETENTION.md](HOMEWORK_RETENTION.md).

### Phase 3 (`2026-10-12_institutions_phase3.sql`)

| Table | Purpose |
|---|---|
| `guardian_links` | student → parent/guardian link: requested → approved (class teacher or `manage_students`) → active once the parent opens a one-time link; declined / revoked with a reason |
| `class_periods` | weekly class timetable (day, start/end, subject, teacher); overlapping periods in a class are rejected by trigger |
| `announcements` | institution / grade / class announcements for staff, students, parents or everyone |
| `conversations`, `conversation_messages` | parent ↔ staff threads about one child; text or meeting requests (proposed / accepted / declined) |
| `student_goals` | personal goals (private to the student) |
| `notification_prefs` | per-kind in-app / email / push switches (email and push stored for later phases) |

Parents never read institution tables directly: `guardian_children()`,
`guardian_child_view(student)` and `guardian_contacts(student)` check an active link
first. Other functions: `request_guardian_link`, `close_guardian_link`,
`post_announcement`, `start_conversation`, `send_message`, `respond_meeting`,
`my_conversations`, `student_guardians`, `timetable_conflicts(inst)`,
`my_achievements()`, `notify(...)` (server only). Scheduled job: `send-reminders`
(pg_cron, hourly at :05) runs `send_reminders()` for homework due in 24 h, overdue
work and exams tomorrow, deduplicated and respecting preferences.

## Licensing (Phase 4, `2026-10-13_licensing_phase4.sql`)

| Table | Purpose |
|---|---|
| `license_codes` | gift / personal / institution codes: SHA-256 `code_hash` + last 4 characters, plan, duration, uses, redeem-by, institution (licences), status |
| `institution_licenses` | activated licences: plan, `starts_at`/`expires_at`, `grace_days`, status |
| `code_redemptions` | who redeemed what and the subscription or licence it created (one per code per account) |

`subscriptions.provider` also allows `gift`. No client grants on the new tables.
Entitlements: `entitlement_sources(user)`, `effective_limits(user)`,
`effective_features(user)`; `plan_of`, `plan_limit`, `has_feature` and
`my_entitlements()` read from them. Functions: `redeem_code`, `my_redemptions`,
`activate_institution_license`, `institution_license_status`, `platform_generate_codes`,
`platform_codes`, `platform_code_redemptions`, `platform_revoke_code`,
`platform_licenses`, `platform_revoke_license`, `platform_update_plan`,
`platform_user_plan`, `platform_grant_plan`, `platform_end_subscription`,
`platform_license_audit`. Server only: `generate_license_codes` (used by
`scripts/generate-codes.mjs`), `claim_code`. Details: [LICENSE_MANAGEMENT.md](LICENSE_MANAGEMENT.md).

Sign-up triggers on `auth.users`: `before_new_user` (institutional accounts need a
valid one-time activation token, which it strips from the metadata) and
`handle_new_user` (creates the profile and membership); `guard_email_change` stops
login addresses being changed through the Auth API.
