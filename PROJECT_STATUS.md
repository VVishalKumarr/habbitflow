# Project status

State as of **12 October 2026**: institution isolation audit and follow-up fixes, and
study insights with adaptive study plans. Earlier phases: [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md).

> **Database and server deployed (12 Oct 2026):** migration
> `2026-10-23_isolation_and_study_insights.sql` applied to the live project and
> `timetable-ai` redeployed. **All 17 test suites (243 checks) pass against the live
> project.** The website changes are not pushed yet.

## Milestone 1 — Isolation audit (read-only)

Checked against the code, not earlier plans:

| Area | Finding |
|---|---|
| Institution IDs, memberships | ✅ UUID per institution; one membership per person per institution with role and status; access needs an active membership in an active institution |
| Records tied to their institution | ✅ `institution_id` on every institution-owned table; composite foreign keys; trigger stops rows moving between schools |
| RLS | ✅ on for all 60 tables; 14 have no client policy (server-only) |
| Institution ID from the app | ✅ never trusted — every policy/function re-derives the caller's role from `auth.uid()` |
| Files | ✅ private bucket, no client storage policies, 2-minute signed URLs, per-subject check |
| AI, notifications, jobs | ✅ AI reads with the student's own token; quotas resolve the institution server-side; notifications are per user; no realtime subscriptions |
| Roles | ✅ coordinators made/removed only with `manage_staff` (heads only); no self-promotion; parent links student-initiated and staff-approved |
| **Gap 1 (medium)** | ❌ subject teachers could read *other subjects'* assessments, marks, submissions and summaries in classes they teach |
| Gap 2 (low) | ❌ class teacher of an *archived* class could still approve parent links |
| Gap 3 (low) | ❌ refused actions weren't logged anywhere |
| Gap 4 (low) | ❌ role changes had no reason and didn't notify the person |

## Milestone 2 — Isolation fixes

| Item | Status |
|---|---|
| Subject scope (`can_view_subject()`) on assessments, marks, submissions, reviews, files metadata, `academic_summary`, `assignment_progress`, `export_marks` | ✅ implemented · ✅ tested on real Postgres (offline) · ✅ tested live |
| Archived-class teachers can't approve parent links | ✅ implemented · ✅ tested offline · ✅ tested live |
| Refusals logged (`deny()` → `access_denied` line in the Postgres log) | ✅ implemented · ✅ verified in the live Postgres log after the test run |
| Role change: reason in audit history, notification, refusals logged; 4-argument calls still work | ✅ implemented · ✅ tested offline · ✅ tested live |
| New tables added to the cross-school leak sweep (`security-review.test.mjs`) | ✅ · ✅ passing live |

## Milestone 3 — Study insights (weak-subject detection)

| Item | Status |
|---|---|
| Per-subject classification with reasons (needs attention / improving / on track / strong / not enough data); missing data never zero; assessment-kind weights; exams; confidence | ✅ implemented · ✅ tested offline |
| Configurable rules per institution (heads; validated; audited) | ✅ · ✅ tested offline |
| History snapshots when data changes or every `refresh_days` | ✅ · ✅ tested offline (found and fixed a bug: corrected marks didn't trigger a new snapshot) |
| Who sees what: student all; subject teachers their subjects; class teacher/coordinator/head their classes; linked parent a summary; everyone else refused | ✅ · ✅ tested offline |
| Screens: School → Study insights (students, staff), overview card, parent summary, rules panel in Settings, role-change reason field | ✅ built · ✅ type-check and production build · ⚠️ not tested in a browser |
| Help article “School: study insights and your study plan” | ✅ |

## Milestone 4 — Adaptive study plans

| Item | Status |
|---|---|
| Planner (`planStudyBoost`): re-label general study, borrow from strong subjects (keep one), add 20–90 min sessions in free cells; daily limit, 6 h/day cap, breaks, school and commitments, waking hours; explains what didn't fit | ✅ · ✅ 13 unit tests |
| Database guard: a study plan can only add or re-label study sessions in the student's own timetable; preview → save; History undo | ✅ · ✅ tested offline |
| Modes off / recommend / auto (auto applies once per change in insights, when the dashboard opens) | ✅ built · ⚠️ auto mode not covered by an automated test |
| Plan adherence (student-only) | ✅ function + unit test · ⚠️ not shown in the UI yet |
| “Explain with AI” (`study_advice`, quota `study_plan`; no marks sent) | ✅ deployed · ✅ plan part tested live · 🔒 AI wording needs `ANTHROPIC_API_KEY` |

## Required acceptance checks

| # | Check | Result |
|---|---|---|
| 1 | Analysis uses only authorised, sufficient data | ✅ offline |
| 2 | Plan keeps fixed commitments; can be reviewed and undone | ✅ unit + offline |
| 3 | Recommendations explain why | ✅ offline + unit |
| 4 | Institution A can't access B's private records | ✅ live (Phase 9 suites) + offline for new functions · ✅ re-run live |
| 5 | Only a principal/director assigns or revokes coordinators | ✅ offline |
| 6 | Only heads or in-scope coordinators assign subject teachers | ✅ offline |
| 7 | Teachers can't elevate themselves | ✅ offline + live (Phase 9) |
| 8 | Only students start parent links | ✅ offline + live (Phase 3) |
| 9 | Parents reach only verified, linked children | ✅ offline + live (Phase 3) |
| 10 | Enforced server-side / by database policies | ✅ offline (RLS on) |
| 11 | Unauthorised operations denied and logged | ✅ denied (tested live) · ✅ log lines verified |
| 12 | Existing habit-tracker data and features unaffected | ✅ all existing live suites pass |
| — | Revoked/suspended memberships lose access at once | ✅ offline |
| — | Platform owner can't read students' insights | ✅ tested live |
| — | Background re-analysis without anyone opening the app | ❌ not implemented (insights refresh whenever they're read) |

✅ = run and passing · ⏳ = written, not yet run · ⚠️ = implemented, not fully tested ·
🔒 = blocked by credentials · ❌ = not implemented.

## Test results (this session)

| Suite | Result |
|---|---|
| `tests/study-plan.test.mjs` (new, unit) | 13 / 13 |
| `tests/local-db.test.mjs` (new, real Postgres in-process via PGlite) | 15 / 15 (schema load + 14 scenarios) |
| `tests/timetable-core.test.mjs`, `tests/webpush.test.mjs` | 12 / 12, 5 / 5 |
| `npm run build` (type-check + build), `deno check` of `timetable-ai` | pass |
| `tests/study-insights.test.mjs` (new, live project) | 16 / 16 |
| `scripts/test-all.mjs` (all unit + backend suites, live project) | 17 suites, 243 checks, all green |

The offline database test loads the real `supabase/schema.sql` into Postgres with small
stand-ins for Supabase's `auth`/`storage`/`cron` schemas and runs as different users
with RLS on. It is a strong check of the SQL, but not a substitute for the live run
(Auth, PostgREST, Storage and the Edge Functions aren't in it).

## What's left

1. Push to deploy the website (GitHub Pages) so the new screens go live.
2. Delete the Supabase access token again when you no longer need database changes.
3. Optional: browser tests for the Study insights screens; show plan adherence to
   students; notify students when a subject changes status; scheduled re-analysis;
   an Anthropic key so “Explain with AI” writes its tips.
