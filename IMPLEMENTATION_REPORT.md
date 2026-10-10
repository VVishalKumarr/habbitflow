# Implementation report — Student Development & Institution Platform

Final report for the nine phases in [ROADMAP.md](ROADMAP.md). State as of Phase 9
(October 2026), Supabase project `udugejhizotqfmzqpnzf`, Android 1.2.0 (versionCode 3).

## Summary

| Phase | Status |
|---|---|
| 1 Institutions, roles, admin dashboards, academic calendar | ✅ done |
| 2 Homework uploads & review, attendance, marks, retention job | ✅ done |
| 3 Students & parents, timetables, announcements, messages, goals, reminders | ✅ done |
| 4 Entitlements, licences, gift codes, friend limits (+ yearly renewal) | ✅ done |
| 5 AI quotas & cost controls | ✅ done |
| 6 AI timetable assistant (+ class teachers edit timetables) | ✅ built; **AI output untested** (no Anthropic key) |
| 7 Development reports, programmes, import/export, PDF, year transition | ✅ done |
| 8 Notification delivery | 🟡 browser push ✅ tested; email and Android push built, need credentials |
| 9 Hardening & release | ✅ done |

## Works today (tested against the live project)

Everything in phases 1–5 and 7; Phase 6 with its built-in fallbacks (command parser,
automatic rescheduling, timetable check numbers); Phase 8 in-app and **browser push**
(real end-to-end test in Google Chrome).

## Built but waiting for your credentials

| Feature | Needs | Until then |
|---|---|---|
| AI help assistant, AI timetable builder, AI advice, AI command understanding | `ANTHROPIC_API_KEY` | help articles; built-in command parser; automatic suggestions; builder says “not switched on” |
| Email: password reset, invitations, notification emails | Resend account + verified domain (`RESEND_API_KEY`, `EMAIL_FROM`) | activation links shown to the inviter (`ALLOW_MANUAL_INVITE_LINKS`), emails recorded as “not set up” |
| Android push | Firebase project, `google-services.json`, `FCM_SERVICE_ACCOUNT`, build with `VITE_ANDROID_PUSH=true` | not offered in the app |
| Web payments | Razorpay account and keys | checkout disabled |
| Play purchases | Play Console product + service account | not offered |
| Analytics, Sentry, AdSense | provider accounts | off |

Protocol-level code for these is unit-tested where possible (FCM token signing, Web Push
encryption against RFC 8291's example). Claim them as working only after a real test.

## Partial / deliberate limits

- AI needs-check questions are a fixed list in the app (the model builds the timetable).
- Rescheduling changes the weekly timetable (no single-date overrides; undo from History).
- The `study_plan` AI quota isn't used by any feature yet.
- Parents don't see development scores.
- Planning/habits counts in development scores only if the student opts in.
- The year transition moves whole classes; individual exceptions are re-enrolled by hand.
- No iPhone app (needs a Mac; see LAUNCH_TODO.md).
- The Android build was compiled and synced but not installed on a physical device in Phase 9.

## Database migrations (apply in this order)

`2026-09-28_pomodoro_friends`, `2026-09-30_launch`, `2026-10-03_three_plans_regional`,
`2026-10-10_institutions_phase1`, `2026-10-11_institutions_phase2`,
`2026-10-12_institutions_phase3`, `2026-10-13_licensing_phase4`, `2026-10-14_license_renewal`,
`2026-10-15_ai_quotas_phase5`, `2026-10-16_ai_timetable_phase6`,
`2026-10-17_teacher_timetables`, `2026-10-18_reports_phase7`,
`2026-10-19_import_year_transition`, `2026-10-20_notification_delivery`,
`2026-10-21_hardening`. All are applied to the live project; `supabase/schema.sql` contains
everything for a fresh project. Details: [DEPLOYMENT.md](DEPLOYMENT.md).

## Test results (end of Phase 9)

`BASE_URL=http://localhost:5173 node --env-file=.env scripts/test-all.mjs --e2e`
— **27 suites, 341 checks, all passing** (after two fixes found by the run, below).

| Kind | Suites |
|---|---|
| Unit (no network) | timetable-core (12), webpush (5) |
| Backend, against the live project | api-security (22), launch-security (23), institutions (25), institutions-phase2 (17), institutions-phase3 (10), licensing (16), ai-quota (15), timetable-ai (14), teacher-timetable (8), reports (12), notifications (10), **security-review (10)** |
| Browser (Playwright) | e2e (30), e2e-social (10), e2e-launch (28), e2e-institution (13), e2e-institution-phase2 (9), e2e-institution-phase3 (10), e2e-licensing (11), e2e-ai-quota (7), e2e-ai-timetable (9), e2e-teacher-timetable (5), e2e-reports (8), e2e-notifications (4, real Chrome push), **e2e-responsive** (240 page × width checks) |

## Security fixes in Phase 9

1. **High — year transition authorisation:** `year_transition` and its preview let any
   signed-in user act on any school (a NULL comparison skipped the head-only check). Fixed and
   covered by tests; no other function had the pattern.
2. **Low — institution settings readable by outsiders.** Fixed.
3. Defence in depth: trigger functions and internal utilities no longer callable by clients.

Full review (method, coverage, third parties): [SECURITY.md](SECURITY.md#phase-9-security-review).

## Other Phase 9 fixes

- Parent overview overflowed on phones (long titles in a grid) → `min-w-0` on all school panels.
- Notification switches could revert if ticked before preferences loaded → disabled until loaded.
- The long-standing Saturday failure in `tests/e2e.mjs` was a test bug (deleted the wrong copy
  of a duplicated task). Fixed; `FAKE_NOW` lets weekday-dependent steps be checked on any day.
- README rewritten; new DEPLOYMENT.md, ANDROID_BUILD.md, this report; `npm run test:all`,
  `npm run aab:release`.

## Remaining work

Your accounts and decisions — tracked in [LAUNCH_TODO.md](LAUNCH_TODO.md): delete the Supabase
access token, prices, domain + Cloudflare Pages, Resend (then remove manual invite links),
leaked-password protection + CAPTCHA, legal review, Razorpay, international payments,
AdSense, Anthropic key, analytics, Sentry, Firebase, Play Console listing, release keystore,
closed test, iOS.

Engineering, when wanted: parents' view of development scores; single-date timetable
overrides; `study_plan` feature; email digests; iOS build.

## How to run, deploy and build

- **Run:** `npm install`, fill `.env`, `npm run dev` — [SETUP.md](SETUP.md)
- **Deploy:** migrations, functions, secrets, jobs, website — [DEPLOYMENT.md](DEPLOYMENT.md)
- **Android:** `npm run apk:debug`; signed bundle `npm run aab:release` after creating the
  keystore — [ANDROID_BUILD.md](ANDROID_BUILD.md)
- **Test:** `npm run test:all` (+ `--e2e` with the dev server) — [SETUP.md §11](SETUP.md#11-tests)
