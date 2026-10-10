# Security

How HabitFlow protects accounts and data, what was tested, and known limitations.
Report a security problem to the contact address on the Privacy page.

## Architecture

| Layer | Holds | Talks to |
| --- | --- | --- |
| Browser / Android app | public Supabase key, the user’s session | Supabase (RLS-protected), Edge Functions |
| Postgres (RLS) | all app data, plans, subscriptions | — |
| Edge Functions | secrets: service role, Resend, Anthropic, Razorpay, Google Play | Supabase admin API, providers |

Nothing secret is in the website bundle: `VITE_*` values are public identifiers only.

## Authentication

- Username + password via Supabase Auth; passwords are bcrypt-hashed by Supabase and
  never stored or logged by the app. Logins use `username@habitflow.local` internally.
- Sensitive actions require the **current password**, checked server-side by
  `check_password()` (bcrypt compare). 5 wrong attempts in 15 minutes locks the check.
  Wrong-password paths return a result instead of raising, so attempts are counted.
- Changing username keeps the same user id; the login address is updated in
  `auth.users` and `auth.identities` in one transaction.

## Password recovery

- Only available if the account has a **confirmed** recovery email.
- The `password-reset` function uses Supabase Auth’s own recovery token
  (`generateLink`): securely generated, **single-use, expires in 1 hour**, verified by
  Supabase. The email links to `/reset-password?token_hash=…`; the app verifies it with
  `verifyOtp`, removes it from the address bar immediately, lets the user set a new
  password, then signs out all sessions.
- Responses are identical whether or not an account matched, and sending happens in the
  background so timing doesn’t reveal accounts. Rate limits: 10/hour per IP, 3/hour per
  identifier.
- No passwords in URLs or emails; no custom reset tokens.

## Recovery email verification

- Adding/changing requires the current password (stops a stolen session from
  redirecting recovery).
- A 32-byte random token is emailed; only its SHA-256 hash is stored; it expires after
  24 h and works once. A verified address stays active until the new one is confirmed,
  and the old address is notified of the change.
- Removing requires the password and shows a warning.

## Authorization (RLS)

- Every table has RLS. Users can read/write only their own rows; composite foreign keys
  prevent attaching rows to another user’s tracker/task.
- `subscriptions`, `plans`, `account_private`, `rate_events` have **no** write access for
  users. Internal helpers (`plan_of`, `has_feature`, `plan_limit`, `are_friends`,
  `hit_rate_limit`) are not executable by users.
- Friends see only daily totals, only while `share_progress` is on; leaderboards are
  opt-in (default off). No task titles, descriptions, timetables, emails ever leave
  their owner through these functions.

## Subscriptions & payments

- Pro status comes only from `subscriptions`, written only by server code after
  verification. There is no `isPro` flag a client can set; the UI reads
  `my_entitlements()` and the database enforces limits independently.
- **Razorpay:** subscriptions are created server-side with the user id in notes; the
  checkout callback’s HMAC signature is verified and the real status is then fetched
  from Razorpay. Webhooks require a valid HMAC-SHA256 signature (constant-time compare).
- **Google Play:** purchase tokens are verified with the Play Developer API using a
  service account; the purchase must carry the user’s id as `obfuscatedAccountId`.
- No fake success paths exist; payment UI is hidden when a provider isn’t configured.

## Exports

CSV and PDF are built from `export_timetable()`, which returns only the caller’s rows and
only for accounts with the feature. Files are generated in the browser and never stored
on a server, so there is no shared URL another user could fetch. CSV cells are protected
against spreadsheet formula injection.

## AI, analytics, errors, ads

- **AI:** API key only on the server; per-user rate limits; the model receives the
  question, recent conversation, page path and plan name — no tasks, emails, passwords,
  tokens or payment data. If the service fails, the app answers from local help articles.
- **Analytics:** allow-listed event names and properties; paths only (no query strings or
  fragments, UUIDs replaced); loaded only after consent.
- **Sentry:** loaded only with a DSN; user info, cookies, headers, bodies and query strings
  disabled; tokens/emails/passwords scrubbed from messages and breadcrumbs.
- **Ads:** only with advertising consent, never for Pro, never on timer/check-offs/account
  flows/errors, no placeholders.

## Tested

`tests/launch-security.test.mjs` and `tests/api-security.test.mjs` run against the real
project and check, among others:

- User A cannot read or modify User B’s trackers, tasks, completions, sessions, profile,
  subscriptions or exports; anonymous users get nothing.
- A free user cannot bypass limits by skipping the UI (direct inserts are refused by the
  database), cannot insert/update subscriptions (`isPro=true`), cannot call internal
  plan functions, cannot set Pro themes, export or use leaderboards.
- Forged Razorpay webhooks are rejected and do not grant Pro; billing needs a valid login.
- Password-protected actions reject wrong passwords; lockout after 5 attempts.
- Username change keeps trackers, friends and plan; old username stops working.
- Recovery tokens: invalid, expired and reused tokens are rejected.
- Friend comparison respects sharing; leaderboard only includes opted-in friends and no
  task names; non-friends can’t compare.
- Account deletion requires the password and removes all data.

## Institutions

- **Institutional accounts** use a real, allowlisted email address and are created only
  by the `institution-activate` function after the invitee opens a one-time link
  (32 random bytes, SHA-256 hashed, 7-day expiry, single use, invalidated on resend or
  withdrawal). A database trigger re-checks the token hash, so the public `signUp`
  endpoint can’t create institutional accounts, even with a guessed invitation id.
  Passwords go straight to Supabase Auth; none are emailed.
- **Roles can’t be self-assigned**: memberships, invitations and audit rows have no
  client write grants; changes go through security-definer functions that check the
  caller. Principals/directors can only be invited by the platform owner and need an
  exact allowlisted address (a domain match is not enough).
- **Tenant isolation** is enforced by RLS on every table plus composite foreign keys
  and an `institution_id`-pinning trigger. Tests modify ids and request other
  institutions’ rows directly through the API.
- **Suspension/removal** deletes the person’s Auth sessions and RLS stops returning
  institutional data at once (an already-issued access token reaches nothing).
- **Audit log** is append-only for every client role and never stores token hashes.
- The **platform owner** cannot read classes, students, assignments or audit entries of
  institutions — only institutions, allowlists and heads.
- Activation lookups are rate-limited per IP (unknown links 30/h; activations 300/h as a backstop, because a whole class may share one school IP);
  invitations 300/h per inviter, resends once a minute and at most 10 times.
- Until email is configured, `ALLOW_MANUAL_INVITE_LINKS=true` shows the activation
  link to the inviter (setup mode, see INSTITUTION_ONBOARDING.md). Disable it if you
  don’t want inviters to be able to activate accounts themselves.

- **Homework files** sit in a private bucket with no client storage policies. Uploads
  are checked server-side for size (4 MB), declared type *and* file signature, the
  student’s enrolment and the submission window. Downloads are 2-minute signed URLs
  issued only to the owner and the assignment’s reviewers. The retention job is
  authenticated by a Vault-held secret (constant-time compare).
- **Attendance and marks** have no client write grants; corrections require a reason
  and the audit log keeps the previous value. Students and parents can’t edit them.
  Marks are validated to 0..max in the database.

- **Parents** get access only through an active guardian link (student request →
  staff approval → one-time, hashed, expiring activation link sent to the parent).
  They read child data only through functions that re-check the link, so revoking it
  cuts access at once. Knowing a student’s name or class grants nothing.
- **Messages** are visible to the two participants only; announcements and their
  notifications reach only the targeted audience.

`tests/institutions.test.mjs` (25 checks), `tests/institutions-phase2.test.mjs` (17),
`tests/institutions-phase3.test.mjs` (10) and the browser suites
`tests/e2e-institution.mjs` (13 steps), `tests/e2e-institution-phase2.mjs` (9) and
`tests/e2e-institution-phase3.mjs` (10) cover the above.

## Licences and gift codes

- Codes are 80-bit random (pgcrypto), shown once and stored only as SHA-256 hashes; no
  master key exists. Redemption is validated and performed atomically in the database
  (row lock, per-code limit, once per account, expiry, revocation, rate limit 10/hour).
- `subscriptions`, `license_codes`, `institution_licenses`, `code_redemptions` and
  `plans` have no client write access; plan and entitlement checks are server-side, so
  editing requests in the browser can't unlock paid features.
- Only the principal/director (locked `manage_license`) can activate a key, and only
  for the institution it was issued for. Licences add features, never permissions.
- `tests/licensing.test.mjs` (15 checks) and `tests/e2e-licensing.mjs` (10 steps).

## AI quotas

- Every AI request is checked and reserved server-side (`ai_begin`, per-user advisory
  lock) before the model is called; clients can't call it, write `ai_usage` or change
  limits, so refreshing, other devices or direct API calls can't bypass a limit.
- Request size, answer length, hourly burst and monthly token caps limit cost and abuse.
- No prompts or answers are stored; institution heads see per-student counts only, the
  platform owner sees personal accounts by username and institution members only in totals.
- `tests/ai-quota.test.mjs` (15 checks) and `tests/e2e-ai-quota.mjs` (7 steps).

## AI timetable assistant

- The `timetable-ai` function never writes: it reads with the student's own token (RLS)
  and returns proposals. Changes are saved only by `apply_timetable_change()` after the
  student confirms; it checks every slot/task belongs to the caller's timetable, refuses
  proposals made for an older version, and runs in one transaction.
- Model output is untrusted: proposals, rescheduling choices and commands are validated
  against fixed shapes and the real timetable (`timetable-core.ts`); a command can only be
  one of a fixed list of student actions.
- `timetable_changes` is append-only for clients; `timetable_preferences` is own-row only.
- Data minimisation as in [AI_TIMETABLE.md](AI_TIMETABLE.md#data-sent-to-the-ai-provider).
- Class teachers' access to students' personal timetables is checked on every call
  (`student_timetable_owner`: class teacher of an active class the student is enrolled in,
  permission on, both memberships active); they never get ticks or progress; every edit is
  audited, notified and undoable. `tests/teacher-timetable.test.mjs` (8),
  `tests/e2e-teacher-timetable.mjs` (5 steps).
- `tests/timetable-core.test.mjs` (12), `tests/timetable-ai.test.mjs` (14),
  `tests/e2e-ai-timetable.mjs` (9 steps).

## Known limitations / to do

- Supabase “secure password change” (re-authentication email) is not used because users
  have no login mailbox; the app verifies the current password itself instead.
- Focus sounds are gated in the UI only (they are generated in the browser; nothing to
  protect server-side).
- The 30-day free view of *your own* statistics is a presentation limit: your raw data is
  yours and needed by the timetable. Server-side history limits apply to comparisons and
  exports.
- Enable Supabase’s leaked-password protection and CAPTCHA on sign-up (Auth settings)
  before a public launch to slow automated sign-ups.
- Google Play verification is implemented but can only be tested once a Play Console
  product exists. Razorpay checkout/webhooks are implemented but untested until you add
  Razorpay test keys (the webhook re-fetches the subscription from Razorpay, so replayed
  or out-of-order events can’t roll a status back).
- The per-IP limit on password-reset requests uses the first `x-forwarded-for` address;
  the per-username/email limit (3/hour) is the one that protects inboxes.
- Username lookups (friend requests) can reveal whether a username exists — inherent to
  adding friends by username.
