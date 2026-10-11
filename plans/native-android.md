# Native Android app — plan stub

**Status:** not started. This file records decisions already fixed so they aren't lost; it becomes the full plan when Android work starts (see `plans/native-apps.md` §12, which says to write this plan before starting, reusing that plan's steps 1–8).

## Identity

- **Package name:** `dev.pi_mobile.app`. It is the reverse of the project domain `pi-mobile.dev`; Java package naming (which Android package names follow) replaces a domain's hyphens with underscores. The iOS bundle id is `dev.pi-mobile.app`; the two can't match exactly because iOS forbids underscores and Android forbids hyphens.
- **Permanent:** the package name can't change once an app is uploaded to Google Play, just as the bundle id can't for Apple.
- **Gradle:** set both `applicationId` (store and Firebase identity) and `namespace` (the Kotlin package of the code) to `dev.pi_mobile.app`. They may differ; keeping them equal is simpler.

## Push

Through the same open-source relay as iOS (`relay/`, deployed at `https://push.pi-mobile.dev`):

- Create a Firebase project and register the Android app with package name `dev.pi_mobile.app`; this produces `google-services.json` for the app.
- Give the relay a Firebase service account: `npx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json` (see `relay/README.md`). The relay sends with the device token and the service account's `project_id` (`relay/src/fcm.ts`); it never uses the package name.
- The app registers with `POST /v1/register {platform: "fcm", token}` and gives the returned `cap` to each paired computer with `push {relay: {url, cap}}`, exactly as iOS does. Payloads are data-only, high priority, carrying `sealed`; the app decrypts locally.

## Deep links (later)

App Links on Android and Universal Links on iOS are deep links from `pi-mobile.dev` into the app; the same files also enable passkeys and password autofill.

- Android: `https://pi-mobile.dev/.well-known/assetlinks.json` names `dev.pi_mobile.app` and the SHA-256 fingerprint of the app's signing certificate.
- iOS: `https://pi-mobile.dev/.well-known/apple-app-site-association` names `RPN22R2GM2.dev.pi-mobile.app` (Team ID plus bundle id).

## Architecture (from `plans/native-apps.md` §12)

Same as iOS, in Kotlin: a `WebView` for the UI with a JavaScript interface named `PiNative` (same messages as `native/ios/BRIDGE.md`); voice in a `microphone` foreground service started from visible UI, a tapped notification or a Quick Settings tile; `stream-webrtc-android` with `JavaAudioDeviceModule` hardware AEC/NS, `MODE_IN_COMMUNICATION`, `setCommunicationDevice`; the bundled `voice-core.js` in a JS engine (QuickJS or `androidx.javascriptengine`); crypto with libsodium (lazysodium) against `native/fixtures/crypto-vectors.json`; HTTPS-only origins; the AI-sharing consent before voice or dictation; no Android Auto UI.
