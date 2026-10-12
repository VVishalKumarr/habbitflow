# Deployment

HabbitFlows has three parts: the **website** (static files), the **Supabase project**
(database, auth, Edge Functions, scheduled jobs) and the **Android app** (see
[ANDROID_BUILD.md](ANDROID_BUILD.md)). This page covers the first two.

Current production: site https://vvishalkumarr.github.io/habbitflows/ (GitHub Pages),
Supabase project `udugejhizotqfmzqpnzf`.

## 1. Database

Fresh project: SQL Editor → run `supabase/schema.sql` (the whole schema, idempotent).

Existing project: apply the migrations you don't have yet, **in date order**:

```bash
node --env-file=.env scripts/db-apply.mjs supabase/migrations/<file>.sql
```

| Migration | Adds |
|---|---|
| `2026-09-28_pomodoro_friends` … `2026-10-03_three_plans_regional` | personal app, plans |
| `2026-10-10_institutions_phase1` … `2026-10-12_institutions_phase3` | schools: roles, homework, attendance, marks, parents |
| `2026-10-13_licensing_phase4`, `2026-10-14_license_renewal` | licences, gift codes, entitlements |
| `2026-10-15_ai_quotas_phase5` | AI limits |
| `2026-10-16_ai_timetable_phase6`, `2026-10-17_teacher_timetables` | AI timetable assistant, teacher edits |
| `2026-10-18_reports_phase7`, `2026-10-19_import_year_transition` | reports, programmes, import/export, year transition |
| `2026-10-20_notification_delivery` | email / push delivery |
| `2026-10-21_hardening` | security hardening (safe to re-run) |
| `2026-10-22_rebrand_habbitflow` | HabbitFlows name in the test notification |
| `2026-10-23_isolation_and_study_insights` | subject-level access, role-change reasons, study insights and study plans |
| `2026-10-24_ai_limits_and_prices` | monthly AI limits, Opus 5.5 cost tracking, new Plus/Pro prices |
| `2026-10-25_free_ai_limits` | smaller Free AI allowance (5 questions, 5 commands, 1 check, 1 reschedule a month) |
| `2026-10-26_ai_model_tiers` | “most capable AI” listed for Plus/Pro (Free uses Haiku) |
| `2026-10-27_rebrand_habbitflows` | HabbitFlows name in the test notification |

All migrations are additive and safe to re-run. `db-apply.mjs` needs
`SUPABASE_ACCESS_TOKEN` in `.env` (supabase.com → Account → Access Tokens); delete the
token afterwards.

Auth settings (dashboard → Authentication): email provider on, **Confirm email off**,
minimum password length 8; turn on **leaked-password protection** and CAPTCHA before a
public launch.

## 2. Edge Functions

```bash
npx supabase functions deploy --project-ref <ref> --use-api
```

| Function | Purpose | Called by |
|---|---|---|
| `password-reset`, `account-email`, `delete-account` | account recovery, recovery email, deletion | app |
| `billing`, `razorpay-webhook`, `google-play-verify` | payments | app / Razorpay |
| `assistant` | AI help assistant | app |
| `timetable-ai` | AI timetable builder, check, reschedule, commands | app |
| `institution-invite`, `institution-activate` | invitations, CSV people import, activation | app |
| `homework` | homework uploads and signed download links | app |
| `notifications` | which notification channels the server has | app |
| `homework-retention` | deletes homework files after the review interval | pg_cron |
| `notify-deliver` | sends email / push notifications | pg_cron |

JWT checks happen inside each function (`supabase/config.toml` sets `verify_jwt = false`).

### Function secrets

`npx supabase secrets set NAME=value --project-ref <ref>`

| Secret | Needed for | Status here |
|---|---|---|
| `SITE_URL`, `ALLOWED_ORIGINS` | links in emails, CORS | ✅ set |
| `RESEND_API_KEY`, `EMAIL_FROM` | password reset, invitations, notification emails | ⏳ needs your Resend account and domain |
| `ALLOW_MANUAL_INVITE_LINKS` | setup mode: show activation links when email isn't set up | set to `true` for now — **remove once email works** |
| `ANTHROPIC_API_KEY` (`AI_MODEL` optional) | AI assistant and timetable AI | ⏳ |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | web payments (India) | ⏳ |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PLAY_PACKAGE_NAME` | Play purchases | ⏳ |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | browser push | ✅ set (`scripts/setup-notify-job.mjs --vapid`) |
| `FCM_SERVICE_ACCOUNT` | Android push | ⏳ needs Firebase |
| `RETENTION_JOB_SECRET`, `NOTIFY_JOB_SECRET` | scheduled jobs | ✅ set by the setup scripts |

## 3. Scheduled jobs (pg_cron)

| Job | When | Set up by |
|---|---|---|
| `homework-retention` | hourly at :17 | `node --env-file=.env scripts/setup-retention-job.mjs` |
| `notify-deliver` | every minute, only when something is due | `node --env-file=.env scripts/setup-notify-job.mjs` |
| `send-reminders` | hourly at :05 | migration (phase 3) |
| `license-reminders` | daily 03:30 UTC | migration (licence renewal) |
| `development-scores` | Mondays 02:15 UTC | migration (phase 7) |

Check them: `select jobname, schedule, active from cron.job;` and recent runs in
`cron.job_run_details`.

## 4. Website

Build: `npm run build` → `dist/` (static). Environment (`VITE_*`, all public):

| Variable | |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | required |
| `VITE_BASE_PATH` | `/habbitflows/` on GitHub Pages, `/` on your own domain and in the Android app |
| `VITE_LEGAL_*`, `VITE_AI_PROVIDER`, analytics, Sentry, ads, payments, `VITE_SUPPORT_URL` | optional, see SETUP.md / PRIVACY_SETUP.md / MONETIZATION.md |

**GitHub Pages (now):** pushing to `main` runs `.github/workflows/deploy.yml` with the
repository *variables*. GitHub Pages' terms don't allow commercial sites.

**Cloudflare Pages (recommended once you have a domain):** connect the repo, build
`npm run build`, output `dist`, same variables with `VITE_BASE_PATH=/`. `public/_redirects`
makes deep links work. Then update the `SITE_URL` / `ALLOWED_ORIGINS` secrets, the Supabase
Auth site URL, and `VAPID_SUBJECT`.

The site needs no server of its own. `public/sw.js` is the push service worker (no caching);
it must be served from the site root (or the base path).

## 5. After deploying

```bash
node --env-file=.env scripts/test-all.mjs        # unit + backend suites against the project
npm run dev & BASE_URL=http://localhost:5173 node --env-file=.env scripts/test-all.mjs --e2e
```

Then by hand on the live site: sign up, create a timetable, log in as an institution user,
turn on push and send a test notification.
