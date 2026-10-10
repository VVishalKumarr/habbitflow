# Notifications: in-app, email and push

Every notification (homework due, feedback, marks, announcements, messages, timetable
changes, licence reminders…) is created in the app first. Each person chooses, per kind, in
**Settings → Notifications**, whether it also comes **by email** and/or **as a push
notification** (both off by default).

| Channel | Status | Needs |
|---|---|---|
| In app (bell) | ✅ working | — |
| Browser push (Chrome, Edge, Firefox, Android Chrome; Safari 16.4+ on macOS / iOS home-screen apps) | ✅ **working — tested end to end in Google Chrome** | VAPID keys (already created on the project) |
| Email | ⏳ built, **not tested** — no email provider configured | Resend account + verified domain |
| Android app push | ⏳ built, **not tested** — no Firebase project | Firebase project, `google-services.json`, service account |

Migration: `supabase/migrations/2026-10-20_notification_delivery.sql`. Functions:
`notify-deliver` (sender, scheduled) and `notifications` (tells the app which channels the
server has).

## How delivery works

1. A notification is inserted → a trigger queues one **delivery per channel** the person
   turned on for that kind (unique per notification and channel).
2. **Push** is due immediately and goes to every device registered on the account.
3. **Email** is due **10 minutes later** and is **skipped** if, by then, the notification was
   read in the app or push reached one of the person's devices — email is the fallback, so
   the same thing isn't announced twice. At most **6 emails per person per hour**; the rest
   stay in the app.
4. A pg_cron job (`notify-deliver`, every minute, only when something is due) calls the
   `notify-deliver` function with a secret header. It claims due deliveries (leased for 5
   minutes so a crash is retried), sends them and records the result.
5. Results: **sent**; **skipped** with a reason (not configured on the server, no devices, no
   email address, already read, delivered by push, email limit, older than 2 days);
   temporary errors retry after 1, 5 and 30 minutes, then **failed**. A channel without
   credentials is recorded as skipped — never as sent.
6. Dead devices (push service answers 404/410, or 10 failures in a row) are removed.

People see their last deliveries and the reasons under **Settings → Notifications → Recent
emails and push**, and can **Send a test notification** (5 an hour).

Email goes to the institutional login address, or for personal accounts to a confirmed
recovery email.

## Browser push (working)

- Keys: created by `node --env-file=.env scripts/setup-notify-job.mjs --vapid` (function
  secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Done for this project.
  **Don't re-run with `--vapid`** unless the private key leaked: new keys make every existing
  browser subscription stop working (people turn push on again).
- Protocol code: `supabase/functions/_shared/webpush.ts` (VAPID RFC 8292, aes128gcm RFC
  8291) using WebCrypto only; `tests/webpush.test.mjs` checks it against the RFC's own
  example byte for byte.
- The app registers `public/sw.js` (push display and click only; no caching) when someone
  presses **Turn on push here**.
- iPhone/iPad: Safari supports web push only for sites added to the home screen (iOS 16.4+).

## Email (to do: needs your accounts)

1. Create a Resend account, add and verify your domain (DNS records).
2. `npx supabase secrets set RESEND_API_KEY=re_… EMAIL_FROM="HabitFlow <no-reply@yourdomain>" --project-ref <ref>`
   (the same secrets as password-reset emails, SETUP.md §4).
3. Settings → Notifications → turn on Email for a kind → **Send a test notification** →
   check the inbox and **Recent emails and push** ("Sent"). Until then emails are recorded as
   “email isn’t set up on the server”.

## Android app push (to do: needs Firebase)

1. Firebase console → create a project → add an Android app with package `com.habitflow.app`
   (see `capacitor.config.ts`) → download **`google-services.json`** into `android/app/`.
2. Project settings → Service accounts → **Generate new private key** →
   `npx supabase secrets set FCM_SERVICE_ACCOUNT="$(cat key.json)" --project-ref <ref>`.
   Keep the key file out of git.
3. Build the app with `VITE_ANDROID_PUSH=true` in `.env` (the switch that shows “Turn on push
   here” in the Android app) and `npm run apk:debug`.
4. On the phone: Settings → Notifications → Turn on push here → allow → Send a test
   notification. Tapping a notification opens its page.

Without these, the Android app says push “is coming with a future update”, and the plugin is
never started (so it can't crash without Firebase).

## Setup and operations

- `node --env-file=.env scripts/setup-notify-job.mjs` — (re)creates the cron job and rotates
  its secret (`NOTIFY_JOB_SECRET`, also in Vault as `notify_job_secret`).
- Health: `select status, reason, count(*) from public.notification_deliveries where created_at > now() - interval '1 day' group by 1, 2;`
- Pause: `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'notify-deliver';`

## Tests

- `node tests/webpush.test.mjs` — Web Push encryption (RFC 8291 example), VAPID JWT, FCM
  service-account JWT (5).
- `node --env-file=.env tests/notifications.test.mjs` — queueing, preferences, 10-minute
  email, skip rules, hourly cap, retries, devices, RLS, test notifications, the real sender
  against Google's push service (10).
- `BASE_URL=http://localhost:5173 node --env-file=.env tests/e2e-notifications.mjs` —
  settings, then **real push in Google Chrome**: subscribe → server sends → the service
  worker shows the notification; turning push off (4). Needs Google Chrome; it opens a
  normal Chrome window off-screen because headless Chrome can't reach the push service.
