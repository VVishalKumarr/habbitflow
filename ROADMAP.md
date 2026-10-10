# Roadmap — Student Development & Institution Platform

Every feature from the master brief and the AI-quota brief, assigned to a phase.
Each phase ends with: migration applied, backend security tests, browser e2e,
type check + lint + production build, docs updated, one commit.

Status: ✅ done (committed) · 🟡 built, not yet verified/committed · ⬜ not started

---

## Phase 1 — Foundation & institutional administration ✅ (`ff40b12`)

- Separate personal (username) and institutional (approved email) sign-in
- Database-driven email allowlist (exact addresses for heads, domains for staff/students)
- One-time, hashed, expiring activation links; resend, suspend, revoke, reactivate
- Roles: Platform Owner (outside hierarchy), Principal/Director, Coordinator and
  Class Teacher (same tier, separate permissions), Subject Teacher, Student
- Configurable permission overrides; head-only permissions locked
- Tenant isolation via RLS, composite foreign keys, institution pinning
- Principal / Coordinator dashboards, people management, classes, subjects, enrolment
- Academic calendar, cross-subject deadline calendar, conflict detection,
  deadline-change approvals
- Institution settings: branding, years/terms, grading scale, workload limits,
  homework retention (≤ 14 days)
- Append-only audit history

## Phase 2 — Academic operations ✅ (`ab00c0c`)

- Subject Teacher and Class Teacher dashboards
- Assignments (window ≤ 1 calendar month)
- Homework uploads: private bucket, 4 MB, PDF/JPG/PNG checked by file signature,
  short-lived signed URLs
- Review workflow: submitted → under review → accepted / resubmission / rejected
- Attendance (daily + per subject), corrections with reason and previous value
- Internal/external/project/practical marks, draft → published
- Hourly retention job (idempotent, retryable, holds, deletion log)
- In-app notifications for submissions, reviews, published marks

## Phase 3 — Students & parents ✅

- Student dashboard with homework to-do list (no tick-to-complete for teacher work)
- Parent/guardian linking: student requests → staff approves → guardian accepts
  one-time email link; revoke/correct links; multiple guardians
- Parent dashboard with child selector (verified children only)
- Class timetables (periods) + timetable conflict report
- Announcements (institution / grade / class audiences)
- Parent–teacher messages and meeting requests
- Personal goals and achievements
- Notification preferences + scheduled reminders (deadlines, overdue, exams)


Known pre-existing issue (not from Phase 3): `tests/e2e.mjs` "progress page" step fails
on Saturdays — the "tomorrow" task wraps to the current week's Sunday, and today's
count shows 1 / 2 instead of 1 / 3. Investigate in Phase 9 regression.

## Phase 4 — Entitlements, licensing & gift codes ✅

Moved ahead of AI because AI quotas (Phase 5) depend on it.

- Central `get_effective_entitlements(user)`: institutional license → membership
  → individual subscription → gift entitlement → Free defaults; expiry/revocation
- Plan features/limits configured in the database (reuse existing `plans`,
  `subscriptions` tables), no scattered plan checks in components
- Add feature `ai_guided_timetable` (AI asks your needs, then builds the timetable)
  to the Plus and Pro plans in the `plans` table; shown on the pricing page only
  once Phase 6 ships it
- Server-side friend limits: Free 1, Plus 3, Pro unlimited, institution as licensed;
  never remove existing friends on downgrade
- Platform Owner dashboard: create institutions, generate institutional and
  individual licenses and gift codes (crypto-random, stored as hashes),
  expiry, redemption limits, revoke, activation/redemption history
- Admin script for generating codes on request (registers them in the DB)
- Licensing section in Principal dashboard: activate institution key
- Gift-code redemption for individuals (atomic, clear errors)
- License expiry grace policy (no academic data deleted)
- License/subscription audit events
- Tests: forged requests can't grant paid features; expired/revoked/fully redeemed
  codes rejected; friend limits per plan
- Docs: `LICENSE_MANAGEMENT.md`

## Phase 5 — AI usage quotas & cost controls ⬜

- Tables: per-plan feature quotas (Free/Plus/Pro/Institution), quota periods
  (day/month/custom), usage records, optional institution credit pool, spend caps
- Features metered separately: timetable generation, evaluation/optimisation,
  text chat, voice commands, homework/study planning, rescheduling; any can be disabled
- Admin-editable quota settings page (Platform Owner); institution admins set
  their own quotas within platform maximums
- One server-side `consume_ai_quota()` — atomic, concurrency-safe; checks auth,
  account status, entitlement, feature enabled, remaining quota
- Counting rules documented: success counts, quota/validation rejections don't,
  provider/server errors refunded, retries de-duplicated by request id
- Structured `quota_exceeded` response with reset time; rate limits and max
  request size (replace current fixed 30/hour, 100/day in `assistant`)
- Record provider tokens / voice seconds; label estimates as estimates
- Usage dashboard: student (quota, used, remaining, reset countdown, upgrade/contact);
  institution admin and Platform Owner aggregates, privacy-scoped
- Tests: correct limits per plan, isolation between students, institutional
  entitlements, period reset, concurrent requests, direct API bypass, disabled
  features, upgrade/downgrade/expiry, students can't edit usage
- Docs: `AI_QUOTAS.md` (or section in `LICENSE_MANAGEMENT.md`)

## Phase 6 — AI timetable assistant ⬜

- Text assistant on the student dashboard, through the existing `assistant`
  function (server-side key), metered by Phase 5
- AI voice commands (replaces a conversational voice assistant): push-to-talk
  mic button, explicit permission, speech→text, then the AI maps the phrase to
  one app action, e.g. "add maths revision tomorrow 6 pm", "move today's
  unfinished tasks to Saturday", "start a 25-minute focus session", "mark
  reading done", "what's due this week?", "open my timetable". Shows the
  understood action and asks for confirmation before anything changes; only
  actions the student is allowed to do; typed command box as fallback when
  speech isn't supported (web + Android/Capacitor permission). Metered as
  "voice commands" in Phase 5
- Needs check before generating (**Plus and Pro feature** for individual accounts,
  feature key `ai_guided_timetable`; institution members get it if their license
  includes it; Free users see an upgrade prompt): the AI first asks the student a short set of
  questions about their main needs, then decides what goes into the timetable.
  It asks only what it can't already see (school hours, class periods, deadlines
  and exams are pre-filled from their records), for example: main goals right now
  (exam prep, catching up, a skill), subjects that need more time, fixed
  commitments (tuition, sports, chores), wake/sleep times, best focus time of day,
  activities to keep or drop. Answers can be typed, tapped from suggestions or
  spoken; the student can skip any question, and saved answers are reused and
  editable next time. The AI then explains what it chose to include and why
- Timetable generation from those answers plus school hours, class periods,
  commitments, deadlines, exams, sleep, breaks; never overlapping; explains
  impossible requests; proposal shown for review before saving
- Timetable evaluation: hours per subject/homework/extracurricular/rest,
  overloaded days, unused slots, deadline conflicts, plain-language advice
- Event-based rescheduling: affected slots → displaced tasks → alternatives →
  before/after view → confirm → save
- Proposals never saved without confirmation; institution schedules read-only
- Timetable change history
- Minimal student data sent to the AI provider; no training use
- Docs: `AI_TIMETABLE.md`

## Phase 7 — Development reports, programmes, import/export ⬜

- Student development score 1–10: components (academic 35, homework 20,
  attendance 15, planning/habits 15, extracurricular/skills 15), normalised,
  configurable weights, "insufficient data" instead of zero, calculation history,
  explanation and improvement suggestions, no reward for unhealthy schedules
- Institution development / habit programmes students can join
- CSV import (students, teachers, classes, subject assignments): templates,
  preview, validation, duplicates, row errors, summary, audit; roles not trusted
  from file
- CSV export: attendance, marks, assignments, development reports, class reports
- Printable PDF reports
- Academic-year transition (archive / promote, history preserved)
- Docs: `DATA_IMPORT_EXPORT.md`

## Phase 8 — Notification delivery ⬜ (needs credentials)

- Email delivery via Resend for chosen notification kinds (respects preferences)
- Browser push (VAPID keys) and Android push (Firebase)
- Duplicate prevention across channels
- Only claimed as working once tested with real credentials
- Docs: `NOTIFICATIONS.md`

## Phase 9 — Hardening & release ⬜

- Responsive pass on every dashboard (phone/tablet/desktop, tables, calendars,
  modals, uploads, no horizontal overflow)
- Security review: cross-institution ID tampering, role self-escalation,
  entitlement forging, storage access, data sent to third parties
- Full regression of existing personal features
- Android: Capacitor sync, debug APK, signed release instructions
- Docs: `README`, `SETUP`, `DEPLOYMENT.md`, `ANDROID_BUILD.md`, `SECURITY.md`
- Final implementation report (done / partial / needs credentials / migrations /
  test results / security fixes / remaining work / run, deploy, APK steps)
