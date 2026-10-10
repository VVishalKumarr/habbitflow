# Setup

How to run HabitFlow locally, configure every optional service, and deploy.
Anything you don't configure is simply switched off — the app keeps working.

## 1. Run locally

Requirements: Node 20+.

```bash
npm install
cp .env.example .env        # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev                 # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Type-check + production build into `dist/` (also writes `404.html` for GitHub Pages) |
| `npm run typecheck` | TypeScript only |
| `npm run apk:debug` | Build web app, sync to Android, build a debug APK |

## 2. Supabase

1. Create a project at supabase.com (or use the existing one).
2. **Database:** open SQL Editor, paste all of `supabase/schema.sql`, run it. It is
   safe to run more than once. For an existing project, run only the newest file
   in `supabase/migrations/`.
3. **API keys:** Project Settings → API → copy the URL and the publishable/anon key
   into `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
4. **Auth settings** (Authentication → Providers → Email): keep “Confirm email” **off**
   (logins use internal `username@habitflow.local` addresses that can’t receive mail).
   Minimum password length 8.
5. **Server functions:** see §3.

### Using the CLI

Create a personal access token (supabase.com → Account → Access Tokens) and put it in
`.env` as `SUPABASE_ACCESS_TOKEN=…` (never commit it; `.env` is git-ignored). Then:

```bash
export SUPABASE_ACCESS_TOKEN=…            # PowerShell: $env:SUPABASE_ACCESS_TOKEN="…"
npx supabase functions deploy --project-ref <ref> --use-api
npx supabase secrets set --project-ref <ref> --env-file supabase/functions/.env
```

Delete the token on the Supabase site when you’re done with it.

## 3. Server functions (Supabase Edge Functions)

Code: `supabase/functions/`. Settings: `supabase/config.toml`. Secrets template:
`supabase/functions/.env.example`.

| Function | Purpose | Needs |
| --- | --- | --- |
| `password-reset` | Emails a one-time reset link | `SITE_URL`, `RESEND_API_KEY`, `EMAIL_FROM` |
| `account-email` | Adds/changes the recovery email, sends confirmation | same as above |
| `assistant` | AI help assistant | `ANTHROPIC_API_KEY` (optional `AI_MODEL`) |
| `billing` | Razorpay checkout create / verify / cancel | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| `razorpay-webhook` | Razorpay subscription events | `RAZORPAY_WEBHOOK_SECRET` |
| `google-play-verify` | Verifies Android purchases | `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` |
| `delete-account` | Deletes the account (cancels Razorpay first) | nothing extra |

Also set `ALLOWED_ORIGINS` (comma-separated site origins allowed to call the functions).
Without a secret, a function answers `503` with a clear code and the app falls back.

## 4. Password recovery (email)

How it works: see [SECURITY.md](SECURITY.md#password-recovery). To switch it on:

1. Own a domain (e.g. `habitflow.app`).
2. Create a free account at [resend.com](https://resend.com), add the domain and
   the DNS records it shows, wait until it’s verified.
3. Create an API key and set the function secrets:
   `RESEND_API_KEY`, `EMAIL_FROM="HabitFlow <no-reply@habitflow.app>"`,
   `SITE_URL=https://your-site` (no trailing slash).
4. Set `VITE_EMAIL_PROVIDER=Resend` so the Privacy Policy lists it.

Supabase’s built-in email service can’t be used here: it only delivers to your own
team’s addresses and the login addresses are not real mailboxes.

## 5. Analytics (Plausible or Umami)

Loaded only after the visitor allows analytics. Pick one:

- **Plausible:** add your site at plausible.io, then
  `VITE_ANALYTICS_PROVIDER=plausible`, `VITE_PLAUSIBLE_DOMAIN=your-domain`.
  Self-hosted? also set `VITE_PLAUSIBLE_SCRIPT_URL`.
- **Umami:** create a website in Umami Cloud or your instance, then
  `VITE_ANALYTICS_PROVIDER=umami`, `VITE_UMAMI_URL=https://…`, `VITE_UMAMI_WEBSITE_ID=…`.

Events are defined in `src/lib/analytics.ts` (one place). See [PRIVACY_SETUP.md](PRIVACY_SETUP.md).

## 6. Sentry (errors)

Create a React project at sentry.io (free tier) and set `VITE_SENTRY_DSN`.
Optional: `VITE_APP_ENV`, `VITE_APP_VERSION`, `VITE_SENTRY_TRACES_SAMPLE_RATE`.
The SDK loads only when a DSN is set and strips tokens, emails, passwords, query strings,
headers, cookies and user info (`src/lib/monitoring.ts`).

## 7. AI assistant

1. Create an API key at console.anthropic.com.
2. `npx supabase secrets set ANTHROPIC_API_KEY=… --project-ref <ref>`
3. Set `VITE_AI_PROVIDER=anthropic` (for the Privacy Policy disclosure) and redeploy the site.

The same key powers the help assistant (`assistant`) and the timetable assistant
(`timetable-ai`); deploy both functions. Model defaults to `claude-opus-5-5` (override with
the `AI_MODEL` secret) with automatic refusal fallback enabled. Limits per plan are set in
Platform admin → AI ([AI_QUOTAS.md](AI_QUOTAS.md)).
Without a key the help assistant answers from the built-in help articles, and the timetable
assistant uses its built-in command parser and automatic suggestions
([AI_TIMETABLE.md](AI_TIMETABLE.md)); the AI timetable builder shows that it isn't switched on.

## 8. Ads, payments, Android billing, pricing

See [MONETIZATION.md](MONETIZATION.md).

## 9. Deploy the website

**GitHub Pages (current):** push to `main`; `.github/workflows/deploy.yml` builds with
`VITE_BASE_PATH=/habitflow/`. Put every `VITE_*` value you use in
*Settings → Secrets and variables → Actions → Variables*. Deep links work through `404.html`.

**Custom domain / Cloudflare Pages (recommended for a commercial site):** GitHub Pages’
terms don’t allow running a business on it. On Cloudflare Pages: connect the repo,
build command `npm run build`, output `dist`, environment variables = your `VITE_*`
values with `VITE_BASE_PATH=/`. `public/_redirects` handles deep links. Then update
`SITE_URL` and `ALLOWED_ORIGINS` secrets and the Supabase Auth site URL.

## 10. Android

```bash
npm run apk:debug     # → android/app/build/outputs/apk/debug/app-debug.apk
```

Requirements: JDK 21 and the Android SDK (`android/local.properties` →
`sdk.dir=C:/Android/Sdk`, forward slashes). Release builds and Play Store: see
[PLAY_STORE_CHECKLIST.md](PLAY_STORE_CHECKLIST.md).

## 11. Tests

```bash
node --env-file=.env tests/api-security.test.mjs      # core data isolation
node --env-file=.env tests/launch-security.test.mjs   # plans, payments, account, friends (needs SUPABASE_ACCESS_TOKEN)
BASE_URL=http://localhost:5173 node tests/e2e.mjs                         # core UI
BASE_URL=http://localhost:5173 node tests/e2e-social.mjs                  # focus + friends
BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-launch.mjs  # launch features + 8 screen sizes
```

All tests create throw-away accounts and delete them afterwards.
