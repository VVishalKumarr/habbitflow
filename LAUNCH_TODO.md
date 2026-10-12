# Launch to-do

Things only you can do (they need your accounts, money or legal decisions).
Tick them off as you go. Details are in the linked docs.

## Soon
- [x] Delete the Supabase access token (supabase.com → Account → Access Tokens) and remove the
      `SUPABASE_ACCESS_TOKEN` line from `.env`. Create a new one when you next need database changes.
- [x] Final prices set in Supabase: Plus ₹99/₹899 · $2.99/$24.99, Pro ₹199/₹1,799 · $5.99/$49.99 (monthly/yearly; raised 2026-10-12). Razorpay/Play plans must use the same amounts — [MONETIZATION.md](MONETIZATION.md#changing-prices-and-limits)

## Before telling the public
- [ ] Buy a domain and move hosting to Cloudflare Pages (GitHub Pages doesn’t allow commercial sites) — [SETUP.md §9](SETUP.md#9-deploy-the-website)
- [ ] Password reset and notification emails: Resend account + verify your domain + set the secrets — [SETUP.md §4](SETUP.md#4-password-recovery-email), then test with “Send a test notification” ([NOTIFICATIONS.md](NOTIFICATIONS.md#email-to-do-needs-your-accounts))
- [ ] When email works: remove the setup-mode secret `ALLOW_MANUAL_INVITE_LINKS` (it shows activation links to the inviter) — [INSTITUTION_ONBOARDING.md](INSTITUTION_ONBOARDING.md)
- [ ] Legal details (`VITE_LEGAL_*`), write a refund policy, have Privacy/Terms reviewed by a lawyer — [PRIVACY_SETUP.md](PRIVACY_SETUP.md)
- [ ] Turn on Supabase leaked-password protection and CAPTCHA for sign-ups — [SECURITY.md](SECURITY.md#known-limitations--to-do)

## To earn money
- [ ] Razorpay account (KYC), create monthly/yearly plans for Plus and Pro, keys + webhook; test with test keys first — [MONETIZATION.md](MONETIZATION.md#web-payments-razorpay-india)
- [ ] International payments: Lemon Squeezy or Paddle account (so people outside India can buy Plus/Pro); ask me to connect it
- [ ] AdSense application (needs the domain) + ad units + `ads.txt` — [MONETIZATION.md](MONETIZATION.md#ads)
- [ ] Donation link (`VITE_SUPPORT_URL`) — optional

## Optional services
- [ ] AI assistant: Anthropic API key — [SETUP.md §7](SETUP.md#7-ai-assistant)
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
