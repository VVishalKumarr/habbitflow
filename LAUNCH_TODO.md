# Launch to-do

Things only you can do (they need your accounts, money or legal decisions).
Tick them off as you go. Details are in the linked docs.

## Waiting on you: keys for login codes, email and payments
Built and committed (commit `00becfa`) but **not live yet**: login with a password or a 6-digit
email code, email required on every personal account, and Stripe card payments. The website must
not be pushed until the server side is deployed with these keys.

Put each key in **`.env`** on its own line and save (Ctrl+S). Never paste keys in the chat.
Then tell Claude which keys are in `.env`: it applies the database changes, deploys the functions,
sets the secrets, runs real tests (a code email and a test payment each), pushes the website and
removes the keys from `.env`. Supabase + Resend alone are enough to switch on codes and email.

```
SUPABASE_ACCESS_TOKEN=sbp_...
RESEND_API_KEY=re_...
ANTHROPIC_API_KEY=sk-ant-...
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

- [ ] **Supabase token** — supabase.com/dashboard/account/tokens → Generate new token (starts `sbp_`).
- [ ] **Resend (all emails: login codes, confirmations, password resets, school invites)**
  1. Sign up at resend.com → **Domains → Add domain** → `habbitflows.com` (region Tokyo or Mumbai).
  2. Resend shows 3–4 DNS records (TXT / MX). Add each in **Cloudflare → habbitflows.com → DNS →
     Records → Add record**, copying Type, Name and Value exactly, with the **orange cloud off**
     (“DNS only”).
  3. Back in Resend click **Verify** (usually minutes).
  4. **API Keys → Create** (Sending access) → `RESEND_API_KEY=re_…`.
  Emails will come from `HabbitFlows <no-reply@habbitflows.com>`.
- [ ] **Anthropic (AI assistant, timetable AI, study tips)** — console.anthropic.com → Billing (add
  credit; $5 is plenty to start) → **API Keys → Create key** → `ANTHROPIC_API_KEY=sk-ant-…`.
- [ ] **Razorpay (India, ₹)** — test mode first, live after KYC.
  1. **Account & Settings → API Keys → Generate** → Key ID and Key Secret (secret shown once).
  2. **Subscriptions → Plans**: create Plus ₹79/month, Plus ₹699/year, Pro ₹149/month,
     Pro ₹1,299/year. Send Claude the 4 plan IDs (`plan_…`; not secret).
  3. **Settings → Webhooks → Add**: URL
     `https://udugejhizotqfmzqpnzf.supabase.co/functions/v1/razorpay-webhook`, all
     **subscription.\*** events, and a long random secret you make up → `RAZORPAY_WEBHOOK_SECRET`.
- [ ] **Stripe (outside India, $)** — test mode first.
  1. **Developers → API keys** → publishable (`pk_…`) and secret (`sk_…`) keys.
  2. **Product catalogue**: Plus $2.49/month and $19.99/year, Pro $4.99/month and $39.99/year.
     Send Claude the 4 price IDs (`price_…`; not secret).
  3. **Developers → Webhooks → Add endpoint**: URL
     `https://udugejhizotqfmzqpnzf.supabase.co/functions/v1/stripe-webhook`, events
     `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` → copy its
     **Signing secret** → `STRIPE_WEBHOOK_SECRET=whsec_…`.
  4. **Settings → Billing → Customer portal** → click **Save** once (turns on “Manage card & invoices”).
- [ ] **Revoke the Supabase tokens that were pasted in chat** (`sbp_fc50…`, `sbp_fc22…`) at
  supabase.com/dashboard/account/tokens.

## Website on habbitflows.com (finish the move)
- [x] Domain bought (GoDaddy), nameservers moved to Cloudflare, site live on Cloudflare Workers.
- [ ] Add `www.habbitflows.com`: Workers & Pages → habbitflows → Domains → Add → Custom domain.
- [ ] Supabase → Authentication → URL Configuration: **Site URL** `https://habbitflows.com`;
  **Redirect URLs** `https://habbitflows.com/**` and `https://www.habbitflows.com/**`.
- [ ] Send Claude your **business name** and **public contact email** for the Privacy/Terms pages.
- [ ] With the next Supabase token, Claude points email links (`SITE_URL`) and the allowed origins
  to habbitflows.com (until then the AI assistant and homework uploads work only on the old
  GitHub address) and turns the old GitHub Pages site into a redirect.
- [ ] Optional: delete the unused GitHub repo `VVishalKumarr/habbitflows-site` (a copy Cloudflare made).

## Soon
- [x] Delete the Supabase access token (supabase.com → Account → Access Tokens) and remove the
      `SUPABASE_ACCESS_TOKEN` line from `.env`. Create a new one when you next need database changes.
- [x] Final prices set in Supabase: Plus ₹79/₹699 · $2.49/$19.99, Pro ₹149/₹1,299 · $4.99/$39.99 (monthly/yearly; set 2026-10-13). Razorpay/Play plans must use the same amounts — [MONETIZATION.md](MONETIZATION.md#changing-prices-and-limits)

## Before telling the public
- [x] Buy a domain and move hosting to Cloudflare (done 2026-10-13: habbitflows.com on Cloudflare Workers)
- [ ] Emails: Resend (see the keys section at the top), then test with “Send a test notification” ([NOTIFICATIONS.md](NOTIFICATIONS.md#email-to-do-needs-your-accounts))
- [ ] When email works: remove the setup-mode secret `ALLOW_MANUAL_INVITE_LINKS` (it shows activation links to the inviter) — [INSTITUTION_ONBOARDING.md](INSTITUTION_ONBOARDING.md)
- [ ] Legal details (`VITE_LEGAL_*`), write a refund policy, have Privacy/Terms reviewed by a lawyer — [PRIVACY_SETUP.md](PRIVACY_SETUP.md)
- [ ] Turn on Supabase leaked-password protection and CAPTCHA for sign-ups — [SECURITY.md](SECURITY.md#known-limitations--to-do)

## To earn money
- [ ] Razorpay account (KYC) and keys — see the keys section at the top; test with test keys first, then switch to live keys
- [ ] International payments: Stripe (built; see the keys section at the top). If your Stripe account is registered in India, check it can accept international cards
- [ ] AdSense application (the domain is ready now) + 3 ad units + `ads.txt` (send Claude the publisher ID and the `ads.txt` line) — [MONETIZATION.md](MONETIZATION.md#ads)
- [ ] Donation link (`VITE_SUPPORT_URL`) — optional

## Optional services
- [ ] AI assistant: Anthropic API key — see the keys section at the top. Once it's on, also set `VITE_AI_PROVIDER=anthropic` so the Privacy Policy names Anthropic
- [ ] Analytics: Plausible or Umami — [SETUP.md §5](SETUP.md#5-analytics-plausible-or-umami)
- [ ] Error tracking: Sentry DSN — [SETUP.md §6](SETUP.md#6-sentry-errors)
- [ ] Forest / café focus sounds: licensed audio files

## Google Play Store (Android)
The Android app is already built; these steps get it onto the Play Store. Full list: [PLAY_STORE_CHECKLIST.md](PLAY_STORE_CHECKLIST.md)
- [ ] Install the new APK on your phone and test it
- [ ] Google Play Console developer account (one-time US$25) and identity verification
- [ ] Create a release keystore, back it up, and build the signed app bundle (`.aab`)
- [ ] Store listing: description, icon, feature graphic, screenshots
- [ ] Privacy policy URL, account-deletion URL, Data safety form, content rating
- [ ] Closed test with testers for 14 days (required for new personal accounts), then production
- [ ] Pro in the app: subscription product + Play Billing plugin + service account secrets
- [ ] Push notifications in the Android app: Firebase project + `google-services.json` + service-account secret, build with `VITE_ANDROID_PUSH=true` — [NOTIFICATIONS.md](NOTIFICATIONS.md#android-app-push-to-do-needs-firebase)
- [ ] Optional: AdMob ads

## Apple App Store (iOS)
Not started: there is no iPhone version of the app yet. The same code can become one with Capacitor.
- [ ] Get access to a Mac with Xcode (Apple only allows building iPhone apps on a Mac)
- [ ] Apple Developer Program membership (US$99 a year)
- [ ] Add the iOS app to the project (`npx cap add ios`) and test it on an iPhone
- [ ] Pro on iPhone must use Apple In-App Purchase (StoreKit) for digital subscriptions; add a server function to verify Apple purchases, like the Google Play one
- [ ] App Store listing: description, screenshots for required iPhone sizes, privacy policy URL, support URL
- [ ] App Privacy “nutrition label” answers that match the Privacy Policy
- [ ] In-app account deletion (already built) and a way to restore purchases
- [ ] TestFlight beta with friends, then submit for App Review
