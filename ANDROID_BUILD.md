# Building the Android app

The Android app is the same web app inside Capacitor 8 (`android/`). Package
`com.habitflow.app`, currently **versionCode 3 / versionName 1.2.0**.

## Requirements

- Node 20+, JDK 21, Android SDK (platform 36 + build-tools)
- `android/local.properties` → `sdk.dir=C:/Android/Sdk` (your path, **forward slashes**)
- `.env` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and **`VITE_BASE_PATH=/`**
  (the app is served from the root inside Android)

## Debug APK (testing on your phone)

```bash
npm run apk:debug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Install: copy to the phone and open it (allow *Install unknown apps*), or
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.

## Release (Play Store)

1. **Create the upload keystore once and back it up** in two safe places (password
   manager + offline copy). Losing it means you can't publish updates.
   ```bash
   keytool -genkey -v -keystore habitflow-release.jks -alias habitflow -keyalg RSA -keysize 2048 -validity 10000
   ```
   Run it inside `android/` so the file is `android/habitflow-release.jks` (git-ignored: `*.jks`).
2. Create `android/keystore.properties` (git-ignored):
   ```
   storeFile=../habitflow-release.jks
   storePassword=…
   keyAlias=habitflow
   keyPassword=…
   ```
   (`storeFile` is relative to `android/app/`, so this points at `android/habitflow-release.jks`.)
3. Raise `versionCode` (and `versionName`) in `android/app/build.gradle` for every upload.
4. Build the signed App Bundle:
   ```bash
   npm run aab:release
   # → android/app/build/outputs/bundle/release/app-release.aab
   ```
   Without `keystore.properties` the bundle is built **unsigned** (fine for checking the
   build, not for uploading).
5. Play Console → your app → enrol in **Play App Signing** → upload the `.aab` to
   **Internal testing** first. Store listing, policy forms and the 14-day closed test:
   [PLAY_STORE_CHECKLIST.md](PLAY_STORE_CHECKLIST.md).

## Permissions in this build

| Permission | Why | When it's asked |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | the app talks to Supabase | never (normal permission) |
| `RECORD_AUDIO` | voice commands in the Timetable assistant | first time someone taps the microphone |
| `POST_NOTIFICATIONS`, `WAKE_LOCK`, `c2dm.RECEIVE` | push notifications (Firebase plugin) | only when push is enabled — not before Firebase is set up |

Speech is recognised by the phone's speech service; HabitFlow never receives audio.
Answer the Play **Data safety** form accordingly (audio isn't collected by the app; see
PRIVACY_SETUP.md).

## Push notifications in the app (optional)

Needs a Firebase project: add `android/app/google-services.json`, set the
`FCM_SERVICE_ACCOUNT` function secret and build with `VITE_ANDROID_PUSH=true`. Without
them the app builds and runs normally; push is simply not offered. Details:
[NOTIFICATIONS.md](NOTIFICATIONS.md#android-app-push-to-do-needs-firebase).

## Updating the app after web changes

Every web change needs a new app build: `npm run cap:sync` (build + copy) then the
debug or release build above. The app doesn't download code at runtime.

## Verified in Phase 9

`npm run build`, `npx cap sync android`, `gradlew assembleDebug` and `gradlew bundleRelease`
(unsigned) all succeed with the speech-recognition and push-notification plugins
(Capacitor 8). Not tested on a physical device in this session.
