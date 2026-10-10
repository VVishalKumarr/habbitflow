# HabitFlow — Habit Tracker & Weekly Timetable

A responsive habit / routine tracker with multiple independent trackers, a weekly
timetable with custom time slots, per-date completion tracking, streaks and charts.
One codebase ships as a website and as an Android app (Capacitor).

- **Live site:** https://vvishalkumarr.github.io/habitflow/
- **Backend:** Supabase (Postgres + Auth + Row Level Security)

## Features

- Username + password accounts only (no email, phone or social login)
- Unlimited trackers (Home Routine, Exam Schedule, Gym…) — create, rename, switch, delete
- Weekly timetable: arbitrary time slots (add / edit / delete, overlap validation),
  click a cell to add a task, tap the circle to tick it off
- Tasks recur weekly on their weekday; **completion is stored per calendar date**
- Task options: complete / incomplete, edit or move, duplicate to another day, delete
- Week navigation (previous / next / today); mobile day view with swipe
- Today panel and today's progress with a mini week strip
- Progress page: overall %, today, weekly %, remaining, current / longest streak,
  totals, weekly bar chart, trend line (7/30/90 days), task performance, donut,
  per-task detail with history
- **Pomodoro focus timer**: focus / short / long breaks with custom lengths, name the
  task you're working on (one-tap suggestions from today's timetable), pause, finish early,
  keeps running across pages and app restarts, chime + vibration when time is up
- Progress is split into **Timetable** and **Pomodoro** tabs; Pomodoro shows focus time
  today / this week / total, streaks, daily focus chart, time per task and session history
- **Friends**: send requests by username, accept / decline, unfriend, and compare
  progress side by side (Pomodoro and timetable shown separately, 7/30/90 days)
- **Public website**: landing page, pricing, Help articles, Privacy Policy, Terms, cookie settings
- **Accounts**: optional recovery email (verified), forgot/reset password by email,
  change username (same account), change password, password-protected account deletion
- **Free & Pro plans** enforced by the database (tracker/friend/history limits, 7-day trial),
  Razorpay checkout for the web, Google Play Billing architecture for Android
- **Pro features**: colour themes, focus sounds, CSV and PDF reports, 90-day stats,
  friend leaderboards (opt-in), no ads
- **AI assistant** (Claude) with page-aware help and an offline fallback from the Help articles
- Privacy-friendly analytics (Plausible/Umami), Sentry error tracking and AdSense —
  all optional, consent-based and switched off until configured
- Settings: light / dark theme, first day of week, 12/24-hour time, JSON export,
  account deletion
- Android: back button closes dialogs → navigates → exits, safe areas, share-sheet export

## Documentation

| File | Covers |
| --- | --- |
| [SETUP.md](SETUP.md) | Running locally, Supabase, server functions, email, analytics, Sentry, AI, deploying, tests |
| [DATABASE.md](DATABASE.md) | Tables, RLS, plans & limits, RPCs, future school/coaching design |
| [SECURITY.md](SECURITY.md) | Auth, password recovery, payments verification, what is tested, limitations |
| [MONETIZATION.md](MONETIZATION.md) | Plans, changing prices, Razorpay, Stripe/Lemon Squeezy, Google Play, ads, donations |
| [AI_QUOTAS.md](AI_QUOTAS.md) | AI limits per plan and school, counting rules, cost controls, usage views |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | In-app, email and push notifications: delivery rules, setup, what's tested |
| [DATA_IMPORT_EXPORT.md](DATA_IMPORT_EXPORT.md) | Development scores, programmes, CSV import/export, PDF reports, academic-year transition |
| [AI_TIMETABLE.md](AI_TIMETABLE.md) | Timetable assistant: AI builder, check, rescheduling, voice commands, history/undo |
| [LICENSE_MANAGEMENT.md](LICENSE_MANAGEMENT.md) | Gift codes, licence codes, institution licences, plan limits, how access is decided |
| [PRIVACY_SETUP.md](PRIVACY_SETUP.md) | Legal details, disclosures, consent, launch checklist |
| [PLAY_STORE_CHECKLIST.md](PLAY_STORE_CHECKLIST.md) | Android release: what’s done and what you must do |

## Tech stack

| Layer | Tech |
| --- | --- |
| UI | React 19, TypeScript, Vite, Tailwind CSS v4, Lucide icons |
| State | Zustand (fine-grained selectors: ticking a task re-renders only that task + progress widgets) |
| Charts | Recharts (lazy-loaded with the Progress page) |
| Backend | Supabase Auth + Postgres with RLS |
| Mobile | Capacitor 8 (Android), plugins: app, status-bar, filesystem, share |
| Tests | Node integration tests (auth/RLS) + Playwright end-to-end |

## Project structure

```
├── src/
│   ├── App.tsx                 routes (public site, account flows, app), guards, Android back button
│   ├── config/                 ONE place for settings: app, legal, analytics, ads, payments, ai, consent, features, sounds
│   ├── content/                help articles (shared with the AI assistant)
│   ├── lib/                    supabase, auth, dates, stats, analytics, monitoring (Sentry), exports, payments/, native
│   ├── store/                  zustand: auth, trackers, trackerData, pomodoro, subscription, consent, friends, focusSound…
│   ├── components/
│   │   ├── layout/             AppShell, PublicLayout, SiteFooter, Logo
│   │   ├── assistant/          AI assistant panel
│   │   ├── ads/ consent/       AdSlot, cookie banner + settings
│   │   ├── subscription/ pricing/  UpgradeModal, plan cards
│   │   ├── settings/ focus/    account dialogs, focus sounds
│   │   ├── dashboard/ timetable/ modals/ charts/ progress/ ui/
│   └── pages/                  Landing, Pro, Help, Privacy, Terms, Login, Register, Forgot/Reset password,
│                               Verify email, Dashboard, Focus, Progress, Friends, Compare, Settings
├── supabase/
│   ├── schema.sql              full schema (idempotent)
│   ├── migrations/             incremental SQL for existing projects
│   └── functions/              Edge Functions: password-reset, account-email, assistant, billing,
│                               razorpay-webhook, google-play-verify, delete-account
├── tests/                      backend security suites + Playwright end-to-end suites
├── android/                    Capacitor Android project
└── .github/workflows/deploy.yml   GitHub Pages deployment
```

## Run locally

Requirements: Node 20+.

```bash
npm install
cp .env.example .env      # then fill in the two values (see below)
npm run dev               # http://localhost:5173
```

### Environment variables

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → **publishable** (or legacy `anon`) key |

Both are public by design — never put the `service_role` / secret key in the frontend.
Security comes from the RLS policies in `supabase/schema.sql`.

## Database setup (new Supabase project)

1. Create a project at https://supabase.com.
2. SQL Editor → paste and run `supabase/schema.sql`.
3. Authentication → Sign In / Providers → Email: keep **Email** enabled and turn
   **Confirm email OFF**; set minimum password length to 8.
4. Put the project URL + publishable key in `.env`.

### Data model

`profiles` (username, preferences) · `trackers` · `time_slots` (start/end `time`, no-overlap trigger) ·
`tasks` (tracker, slot, weekday 0–6, title, description, category) ·
`task_completions` (task, **completion_date**, completed — unique per task+date).

Every table has `user_id` and an RLS policy `user_id = auth.uid()`. Composite foreign keys
(`(tracker_id, user_id)`, `(task_id, tracker_id)` …) make it impossible to attach a row to
another user's tracker, slot or task, even through the raw API.

## How authentication works

- The UI asks only for a username and password.
- Supabase Auth requires an e-mail-shaped login, so `alice` is stored as the synthetic,
  never-contacted login `alice@habitflow.local`. A database trigger rejects any sign-up whose
  username and login do not match, and creates the `profiles` row.
- Passwords are hashed with bcrypt by Supabase Auth; they are never stored or logged by the app.
- Sessions (JWT + refresh token) persist in local storage, so reopening the site/app keeps you
  logged in until you log out. Tokens refresh automatically.
- Account deletion (Settings) requires the current password; the `delete-account` server
  function cancels any web subscription, then deletes the auth user; all data cascades.
- Optional recovery email + password reset by email, username change and password change:
  see [SECURITY.md](SECURITY.md).

## Tests

```bash
node --env-file=.env tests/api-security.test.mjs      # auth + RLS, pomodoro, friends (22 checks)
node --env-file=.env tests/launch-security.test.mjs   # plans, payments, account, privacy (22 checks)
npm run dev   # in another terminal, then:
BASE_URL=http://localhost:5173 node tests/e2e.mjs                         # core UI, 7 screen sizes
BASE_URL=http://localhost:5173 node tests/e2e-social.mjs                  # focus timer + friends
BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-launch.mjs  # launch features, 8 screen sizes
```

(First run: `npx playwright install chromium`.)

## Deploying the website

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds with the repository
**variables** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` and publishes `dist/` to GitHub Pages.
The site uses real paths (`/dashboard`, `/help/…`); old `#/…` links redirect automatically.
Set `VITE_BASE_PATH` to the sub-path the site is served from (`/habitflow/` on GitHub Pages,
`/` on a custom domain or in the Android app). `404.html` (GitHub Pages) and `public/_redirects`
(Cloudflare Pages / Netlify) make deep links work. See [SETUP.md](SETUP.md#9-deploy-the-website).

## Android APK

Requirements: JDK 21, Android SDK (platform 36, build-tools), `ANDROID_HOME` set or
`android/local.properties` containing `sdk.dir=C:/Android/Sdk` (your path).

```bash
npm install
npm run build          # web build (reads .env)
npx cap sync android   # copy web assets + plugins into the Android project
npx cap open android   # optional: open in Android Studio
```

**Debug APK** (installable, signed with the debug key):

```bash
cd android
gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Shortcut: `npm run apk:debug` (Windows).

**Release APK:**

1. Create a keystore once (keep it safe — you need it for every update):
   `keytool -genkey -v -keystore habitflow-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias habitflow`
2. Build and sign:
   ```bash
   cd android
   gradlew assembleRelease
   # sign + align (build-tools):
   zipalign -v -p 4 app/build/outputs/apk/release/app-release-unsigned.apk app-release-aligned.apk
   apksigner sign --ks ../habitflow-release.jks --out app-release.apk app-release-aligned.apk
   ```
   Or in Android Studio: *Build → Generate Signed App Bundle / APK*.
3. For the Play Store build an `.aab` instead: `gradlew bundleRelease`.

Install on a phone: enable *Install unknown apps* and open the APK, or `adb install app-debug.apk`.
