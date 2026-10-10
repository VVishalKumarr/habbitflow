# HabitFlow — habit tracker, weekly timetable and school platform

One codebase that ships as a **website** and an **Android app** (Capacitor):

- a personal habit tracker and weekly timetable (Free / Plus / Pro), and
- a platform for **schools, colleges and coaching centres**: staff, students and parents,
  homework, attendance, marks, timetables, reports — each institution isolated from the others.

- **Live site:** https://vvishalkumarr.github.io/habitflow/
- **Backend:** Supabase (Postgres with Row Level Security, Auth, Edge Functions, pg_cron)
- **Status / what's done and what needs your accounts:** [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) · [LAUNCH_TODO.md](LAUNCH_TODO.md)

## Features

**Personal**
- Username + password accounts; optional recovery email, password reset, username change, account deletion
- Multiple trackers; weekly timetable with custom time slots; per-date completion; streaks
- Progress statistics and charts; Pomodoro focus timer with history; friends and comparisons
- Free / Plus / Pro plans enforced in the database; gift and licence codes; Razorpay (web) and Google Play architecture
- **Timetable assistant**: typed or spoken commands with confirmation, AI timetable builder
  (asks your needs first), timetable check, rescheduling around events, history and undo
- AI help assistant; per-plan AI quotas and cost controls

**Institutions**
- Invited institutional accounts (approved email list), roles: principal/director, coordinator,
  class teacher, subject teacher, student, parent — with configurable permissions
- Classes, subjects, enrolment, academic calendar with deadline-conflict checks
- Homework with private file uploads, review workflow and automatic retention
- Attendance, marks (draft → published), class timetables, announcements, parent–teacher messages
- Parents linked and approved per child; parent dashboard
- Class teachers can adjust students' timetables (students notified, can undo)
- Development score 1–10, programmes, class reports, PDF reports, CSV export and import
- Yearly institution licences with renewal reminders; academic-year transition
- Notifications in the app, by browser push (working) and email / Android push (need credentials)

## Documentation

| File | Covers |
| --- | --- |
| [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) | Final report: done / partial / needs credentials, tests, security fixes |
| [SETUP.md](SETUP.md) | Run locally, Supabase, functions, email, analytics, Sentry, AI |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Migrations, Edge Functions, secrets, scheduled jobs, website hosting |
| [ANDROID_BUILD.md](ANDROID_BUILD.md) | Debug APK, signed release bundle, permissions |
| [PLAY_STORE_CHECKLIST.md](PLAY_STORE_CHECKLIST.md) | Play Store listing and policy forms |
| [SECURITY.md](SECURITY.md) | Security model, what's tested, Phase 9 review |
| [DATABASE.md](DATABASE.md) | Tables, RLS, functions per phase |
| [ROLE_PERMISSIONS.md](ROLE_PERMISSIONS.md) | Who can do what in an institution |
| [INSTITUTION_ONBOARDING.md](INSTITUTION_ONBOARDING.md) | Setting up a new school |
| [LICENSE_MANAGEMENT.md](LICENSE_MANAGEMENT.md) | Gift codes, licences, entitlements |
| [MONETIZATION.md](MONETIZATION.md) | Plans, prices, payments, ads |
| [AI_QUOTAS.md](AI_QUOTAS.md) · [AI_TIMETABLE.md](AI_TIMETABLE.md) | AI limits; timetable assistant |
| [DATA_IMPORT_EXPORT.md](DATA_IMPORT_EXPORT.md) | Development scores, programmes, import/export, PDF, year transition |
| [HOMEWORK_RETENTION.md](HOMEWORK_RETENTION.md) | Homework file retention job |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Email and push delivery |
| [PRIVACY_SETUP.md](PRIVACY_SETUP.md) | Legal details and disclosures |
| [ROADMAP.md](ROADMAP.md) | Phases and status |

## Tech stack

| Layer | Tech |
| --- | --- |
| UI | React 19, TypeScript, Vite, Tailwind CSS v4, Lucide icons, Recharts, jsPDF |
| State | Zustand |
| Backend | Supabase: Postgres + RLS, Auth, Storage (private homework bucket), Edge Functions (Deno), pg_cron, Vault |
| AI | Claude via the Anthropic SDK (server-side only) |
| Mobile | Capacitor 8 (Android): app, status-bar, filesystem, share, speech-recognition, push-notifications |
| Tests | Node integration suites against the real project + Playwright end-to-end |

## Project structure

```
src/
  App.tsx                 routes, guards, Android back button
  config/                 app, legal, analytics, ads, payments, ai, features…
  lib/                    supabase, auth, dates, stats, exports, csv, reportPdf, push, speech, timetableAi…
  store/                  zustand stores
  components/             layout, timetable, timetable-ai, school, settings, charts, ui…
  pages/                  public site, personal app, school/ (institution area), admin/
public/sw.js              push service worker (no caching)
supabase/
  schema.sql              full schema (idempotent)
  migrations/             incremental SQL, applied in date order
  functions/              Edge Functions (+ _shared: http, email, ai-quota, webpush, fcm, timetable-core…)
scripts/                  db-apply, setup jobs, generate codes, test-all…
tests/                    backend suites (*.test.mjs) and browser suites (e2e-*.mjs)
android/                  Capacitor Android project
```

## Run locally

```bash
npm install
cp .env.example .env      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev               # http://localhost:5173
```

Both values are public by design; security comes from RLS and server-side checks. Never
put the service-role key in the frontend. Full setup: [SETUP.md](SETUP.md).

## Tests

```bash
npm run test:all                                   # unit + backend suites (needs SUPABASE_ACCESS_TOKEN in .env)
npm run dev                                        # then, in another terminal:
BASE_URL=http://localhost:5173 node --env-file=.env scripts/test-all.mjs --e2e   # everything incl. browser tests
```

27 suites / 341 checks at the end of Phase 9. Tests create throw-away accounts and schools
and delete them afterwards. First run: `npx playwright install chromium` (the push test also
uses an installed Google Chrome).

## Deploy and Android

Website, database, functions, secrets and jobs: [DEPLOYMENT.md](DEPLOYMENT.md).
Android APK and Play Store bundle: [ANDROID_BUILD.md](ANDROID_BUILD.md) (`npm run apk:debug`,
`npm run aab:release`).
