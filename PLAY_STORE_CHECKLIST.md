# Google Play release checklist

The app is **not** automatically Play Store compliant. This lists what’s done and what
you still need to do by hand.

## Already in place

- [x] Application id `com.habitflow.app`, app name “HabitFlow” (`capacitor.config.ts`, `android/app/build.gradle`)
- [x] App icon (check mark) and splash screen resources
- [x] Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`; `RECORD_AUDIO` (voice commands, asked on first use); notification permissions from the push plugin (asked only when push is enabled) — see [ANDROID_BUILD.md](ANDROID_BUILD.md#permissions-in-this-build)
- [x] HTTPS only (`usesCleartextTraffic="false"`); Android backups disabled so login tokens aren’t copied off-device
- [x] versionCode 3 / versionName 1.2.0
- [x] Release signing reads `android/keystore.properties` (git-ignored) when present
- [x] In-app account deletion (Settings → Data → Delete account), password-protected
- [x] Privacy Policy and Terms pages in the app and on the web
- [x] Android never shows web checkout for Pro (Play Billing policy)
- [x] Hardware back button: closes dialogs → goes back → exits
- [x] Opens straight to login/dashboard (no marketing page) inside the app

## You need to do

### Account & listing
- [ ] Google Play Console developer account (one-time US$25), identity verification
- [ ] Decide if the name “HabitFlow” is free to use (other apps use it; check trademarks)
- [ ] Store listing: short/full description, 512×512 icon, 1024×500 feature graphic,
      phone screenshots (use `screenshots/*-390.png` as a starting point), category (Productivity)
- [ ] Contact email and website on the listing

### Policy forms
- [ ] **Privacy policy URL** (public page, e.g. `https://<your-site>/privacy`)
- [ ] **Account deletion URL** — Play requires a web page too: point to `https://<your-site>/help/account-and-security`
      (explains in-app deletion); add an email option for users who can’t log in
- [ ] **Data safety form**: collected = username, optional email, user content (tasks, focus
      sessions), app interactions (only if analytics on), crash logs (only if Sentry on),
      purchase history (if Pro). Encrypted in transit: yes. Deletion: yes. Microphone: speech is
      recognised by the phone’s speech service — HabitFlow doesn’t collect audio. Schools: names,
      institutional email, homework files, attendance, marks (collected for the institution).
- [ ] Content rating questionnaire; target audience (set a minimum age — see PRIVACY_SETUP.md)
- [ ] Ads declaration (“contains ads” only once AdMob is integrated)

### Release build
1. Create a keystore once and **back it up** (losing it means you can’t update the app):
   ```bash
   keytool -genkey -v -keystore habitflow-release.jks -alias habitflow -keyalg RSA -keysize 2048 -validity 10000
   ```
2. `android/keystore.properties`:
   ```
   storeFile=../habitflow-release.jks
   storePassword=…
   keyAlias=habitflow
   keyPassword=…
   ```
3. Build an App Bundle: `npm run cap:sync && cd android && gradlew.bat bundleRelease`
   → `android/app/build/outputs/bundle/release/app-release.aab`
4. Enroll in Play App Signing; upload to **Internal testing** first, then closed testing
   (new personal accounts must run a closed test with testers for 14 days before production).
- [ ] Bump `versionCode` for every upload

### Billing (Pro in the app)
- [ ] Create the subscription product and base plans in Play Console
- [ ] Service account + `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / `GOOGLE_PLAY_PACKAGE_NAME` secrets
- [ ] Add a billing plugin and implement `src/lib/payments/googlePlay.ts`
- [ ] Real-time developer notifications for renewals/cancellations
- [ ] Test with license testers
(Details: MONETIZATION.md → Android.)

### AdMob (optional)
- [ ] AdMob account + app id; `@capacitor-community/admob`; app id meta-data in the manifest;
      UMP consent flow; AdMob branch in `AdSlot`; update Data safety + ads declaration

### Final checks
- [ ] Test on a real device: login, timetable, focus timer in background, back button, dark mode
- [ ] Target SDK meets Play’s current requirement (currently `targetSdkVersion = 36`)
- [ ] Remove any test accounts/data
