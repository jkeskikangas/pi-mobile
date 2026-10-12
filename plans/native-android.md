# Native Android app — Implementation plan

**Goal:** a native Android app with feature parity with the iOS app (`native/ios/`) and the web app (`web/`), following the iOS design principles (`docs/design-principles.md`, `docs/ui.md`) adjusted for Android conventions. Same architecture as iOS (`plans/native-apps.md`): the web UI in a `WebView`, natively only what the web can't do.
**Read first:** `plans/native-apps.md` (decisions D1–D12, protocol §1, steps 1–8; this plan reuses them), `native/ios/BRIDGE.md` (web ↔ native contract, implemented unchanged), `native/ios/README.md` (features, consent, ATS, push), `docs/voice.md`, `docs/design-principles.md`, `docs/ui.md`, `docs/native-research.md` §10 (Android).
**Reference implementation:** the Swift sources in `native/ios/Pi/` (port file by file; behaviour for behaviour) and their tests in `native/ios/PiTests/` (port each test).

## Identity (fixed)

A placeholder app reserved the package name; this plan turns `native/android/` into the real app.

- **Package name:** `dev.pi_mobile.app` (reverse of `pi-mobile.dev`; Java package naming replaces hyphens with underscores; iOS is `dev.pi-mobile.app`). Permanent once uploaded. `applicationId` = `namespace`.
- **Push:** through the same relay as iOS (`relay/`, `https://push.pi-mobile.dev`): `POST /v1/register {platform: "fcm", token}` → `{cap}`, then `push {relay: {url, cap}}` to each computer. Data-only, high-priority FCM messages carrying `sealed`; the app decrypts locally. The relay sends with its own Firebase service account (`relay/src/fcm.ts`).
- **Deep links (later):** `https://pi-mobile.dev/.well-known/assetlinks.json` naming `dev.pi_mobile.app` and the signing certificate SHA-256.

## Decisions (Android-specific; the iOS decisions D1–D12 hold unless replaced here)

| # | Decision | Why |
|---|---|---|
| A1 | **Kotlin, Jetpack Compose (Material 3) for native screens, one `:app` module**, minSdk 26, target/compile 36, AGP 8.13, Kotlin 2.4, Gradle 8.14.3 wrapper, JDK 21. | One module keeps the port 1:1 with the iOS folders; Compose is the Android counterpart of SwiftUI. |
| A2 | **Packages mirror the iOS folders:** `core` (Core), `app` (App), `pairing`, `consent`, `shell`, `voice`, `voiceui`, `dictation`, `push`, `intents` (QS tile, shortcuts). | An agent can find the Swift counterpart of every Kotlin file. |
| A3 | **Crypto: BouncyCastle `XSalsa20Engine` + `Poly1305`** composing NaCl secretbox (replaces lazysodium). | Pure Java: the tweetnacl vectors run as plain JVM tests; no JNI. Verified against `native/fixtures/crypto-vectors.json`. |
| A4 | **JSON: kotlinx.serialization `JsonElement`** with helpers in `core/Json.kt` (`raw["type"].string`). | The Swift app's `JSON` enum, same reading style. |
| A5 | **HTTP: OkHttp** for RPC, pairing, relay and the SSE stream (`followRedirects(false)`; the RedirectGuard rule). Origins: HTTPS only plus plain-HTTP loopback (`OriginPolicy`, same sentences with "phone" instead of "iPhone"). `network_security_config.xml` allows cleartext only to `127.0.0.1`/`localhost` (emulator tests use `adb reverse`). | Same trust rules as iOS ATS. |
| A6 | **Machines in an Android-Keystore-encrypted file** (`MachineStore`: AES-256-GCM key in AndroidKeyStore, ciphertext in private `SharedPreferences`, excluded from backup). | The Keychain counterpart; survives locked-screen voice (no user-auth requirement). |
| A7 | **Web shell: `android.webkit.WebView` + androidx.webkit.** `WebViewCompat.addDocumentStartJavaScript` injects the setup script (BRIDGE.md → Setup) and a shim defining `window.webkit.messageHandlers.piNative.postMessage(msg)` that returns a Promise; `WebViewCompat.addWebMessageListener("piNativeAndroid", setOf(primaryOrigin))` receives `{id, msg}` with `isMainFrame` and `sourceOrigin`, and native replies `{id, ok}` / `{id, error}` through the `JavaScriptReplyProxy`. | The web (`web/app.js`, `web/voice.js`) calls `window.webkit?.messageHandlers?.piNative?.postMessage`; the shim keeps the web contract identical, and the listener's origin allowlist gives BRIDGE.md's trust rule. `window.PiNative` also gets `platform: "android"` so web copy can say Android/phone instead of iPhone. |
| A8 | **Voice mode in a foreground service** (`VoiceService`, `foregroundServiceType="microphone"`), started from visible UI, a tapped notification, the Quick Settings tile or the launcher shortcut. Its ongoing notification is the Live Activity counterpart: state, label, question, elapsed, Mute and End actions; promoted ongoing on Android 16. | Android needs a microphone FGS to keep capturing with the screen off. |
| A9 | **WebRTC: `io.getstream:stream-webrtc-android`** with `JavaAudioDeviceModule` (hardware AEC + NS), audio track + `oai-events` data channel, same SDP exchange through `voiceSession`. Audio: `AudioManager.MODE_IN_COMMUNICATION`, `setCommunicationDevice` (API 31+, SCO before), audio focus for interruptions, `AudioDeviceCallback` for route changes (never stop on headset loss; speaker). | Plan §12. |
| A10 | **`web/voice-core.js` runs in QuickJS** (`io.github.dokar3:quickjs-kt`, Android and JVM), bundled from `web/` at build time (`bundleVoiceCore` task → assets). JVM tests evaluate the same file from the repo. | D3: one source of truth; no downloaded code. |
| A11 | **Hands-free start:** Quick Settings tile "Talk to pi" (`TileService`), a static launcher shortcut, and "Answer by voice" on a notification. No Android Auto UI, no Assistant App Actions. | Counterparts of the Control widget, Siri phrase and Action button. |
| A12 | **QR scanning: CameraX + ML Kit barcode scanning (bundled model)** in a Compose screen (pairing) and a sheet over the web view (`scan` bridge message). | Works without Play services; VisionKit counterpart. |
| A13 | **Dictation audio: `MediaRecorder`** AAC in MPEG-4, mono, 16 kHz → `{audio: base64, mime: "audio/mp4"}`; levels from `getMaxAmplitude()`. | Same as iOS (`AudioRecorder.swift`). |
| A14 | **Push without the google-services plugin:** `FirebaseApp.initializeApp` with options from Gradle properties (`piFirebaseProjectId`, `piFirebaseAppId`, `piFirebaseApiKey`, `piFirebaseSenderId`); empty = push not available in this build (`push.status available:false`, the `PI_PUSH=NO` counterpart). | Builds and tests run without a Firebase project. |
| A15 | **Design:** the iOS look adjusted for Android: system light/dark, the web's tokens (`docs/ui.md`) as the Compose colour scheme, Material 3 components where iOS uses system ones (bottom sheets, dialogs, switches), edge-to-edge with system-bar insets, predictive back closes sheets and the voice screen, haptics via `HapticFeedbackConstants`, Android permission flows (rationale → request → "Open settings"). Same copy as iOS, with "phone"/"Android" for "iPhone". | Familiar on Android, same product. |

## Layout

```
native/android/
  app/build.gradle.kts          dependencies, bundleVoiceCore, BuildConfig (relay, Firebase)
  app/src/main/AndroidManifest.xml
  app/src/main/java/dev/pi_mobile/app/
    core/        Json, Envelope, Models, HubClient (pair, rpc, agent, SSE), SseParser, OriginPolicy, MachineStore, Prefs, PushContent
    app/         PiApplication, MainActivity, AppModel (machines, prefs, one HubClient per machine), PushCenter
    pairing/     PairingScreen (scan, paste, inline errors), QrScanner (CameraX + ML Kit)
    consent/     AIConsent (stored OK, gate), ConsentSheet
    shell/       WebShell (WebView, setup script, shim), ShellScreen (loading/offline), NativeBridge (piNative), NetworkWatch, ScanCenter
    voice/       VoiceEngine (port of web/voice.js VoiceMode / VoiceEngine.swift), VoiceCore (QuickJS), VoicePorts, RealtimeClient + Levels (WebRTC),
                 AudioSessionController, BasicVoice, Earcons, LiveFleet, VoiceHost, VoiceService (foreground), VoiceNotification
    voiceui/     VoiceScreen, Orb, QuestionCard, VoiceSheets, VoicePalette, VoiceHaptics, VoiceFixtures
    dictation/   Dictation (dictation.* bridge calls), AudioRecorder (MediaRecorder)
    push/        PiMessagingService (FCM), relay registration (in PushCenter), notification posting, Answer by voice
    intents/     StartVoiceTile (Quick Settings), shortcuts
    ui/          Theme (tokens), shared components
  app/src/test/            JVM tests (ports of PiTests; Robolectric where Android APIs are needed)
  app/src/androidTest/     instrumented end to end against the fixture hub
  scripts/                 integration.sh, e2e.sh (fixture hub + emulator + adb reverse)
  shots/                   screenshots
```

## Steps (each ends green: `./gradlew assembleDebug testDebugUnitTest lint`, and `npm test` when TypeScript/JS changed)

**Status (2026-10-12):** steps 1–10 done and green on the emulator; a parity audit against `native/ios` (file by file, every BRIDGE.md message, every PiTests case) was run and its findings fixed (launch requests wait for the activity; sessions only from the app's own notifications through the non-exported `.app.NotificationOpen` alias; a locked phone gets only state, Mute and End; guarded foreground-service starts; audio re-applied after calls; pi's phone-wide mic mute is always lifted; redial only on a network type change; R8 minification with an R8 that reads Kotlin 2.4). What's left is device-only (`native/android/README.md` → Device checklist) and push needing a Firebase project.

1. **Scaffold** — wrapper, dependencies, `core/Json`, `core/Models`, `core/Envelope` + `CryptoVectorTest`.
2. **Core** — port `HubClient` (OkHttp; pair; rpc/agent/hub/focus; SSE events with reconnect backoff 0.5–8 s, 40 s stall, `hello` → re-focus, 401 → unauthorized; errors as sentences), `SSEParser`, `OriginPolicy` (+ redirect rule), `MachineStore` (encrypted, migration-free), `Prefs` (voice prefs, last focus), `PushContent`. Tests: ports of `SSEParserTests`, `HubClientTests` (MockWebServer), `OriginPolicyTests`, and an integration test against the fixture hub (`npm run ui`), skipped without a link.
3. **Voice engine** — port `VoiceCore`, `VoicePorts`, `VoiceEngine`, `BasicVoice` (logic), `LiveFleet` with the same seams; tests: ports of `VoiceCoreTests`, `VoiceEngineTests`, `BasicVoiceTests` with `FakeRealtime`/`FakeHub` and the real `web/voice-core.js`.
4. **Shell, pairing, consent, dictation** — `MainActivity`/`AppModel`, `PairingScreen` + `QrScanner`, `ConsentSheet`, `WebShell` + `NativeBridge` (every BRIDGE.md message), `ShellScreen` (loading, "Can't reach ‹name›" + Try again, never a WebView error page; no white flash), `Dictation` + `AudioRecorder`, `NetworkWatch`, `ScanCenter`. Tests: ports of `BridgeTests`, `DictationTests`, `DictationSilenceTests`, `ConsentTests`.
5. **Voice platform and UI** — `RealtimeClient` (WebRTC), `Levels`, `AudioSessionController`, `Earcons`, `BasicVoice` audio (AudioRecord, MediaPlayer, TextToSpeech), `VoiceService` + notification (Mute/End), `VoiceHost` (`voice.start`, consent gate, last session / needs-you pick), `VoiceScreen` (orb, captions, question card with undo countdown, Mute/End, session switcher, settings sheet with persona picker and samples), haptics, keep screen on while visible. Tests: `VoiceActivityTests` counterpart for the notification content; screenshot tests per state, light and dark.
6. **Hands-free start** — `StartVoiceTile`, launcher shortcut (dynamic, `intents/VoiceShortcuts`, so it can be disabled while nothing is paired), "Answer by voice".
7. **Push** — `PushCenter` (FCM token, relay register/reconcile with the iOS rules: 501 pause 6 h, other failures 5 min; `push {relay}` to every computer; off → `{relay: null}`), `PiMessagingService` (open `sealed` with the matching machine key, post the notification grouped by machine/session; urgent → "Answer by voice"), tap → `PiNative.focus`. `POST_NOTIFICATIONS` asked only from the menu. Tests: ports of `PushTests`, `PushRelayTests`.
8. **Web** — copy that says iPhone inside the app says the platform's word when `PiNative.platform === "android"` (notifications permission hint, Home Screen note never shown in the app); nothing else changes in a browser. `npm test`.
9. **End to end** — `scripts/e2e.sh`: fixture hub, emulator, `adb reverse`, instrumented test pairs with a link, loads the web UI, consent → voice screen in basic voice → End, a dictation take reaches `transcribe`, menu shows Stop sharing my voice and the notifications state. Screenshots in `native/android/shots/`.
10. **Docs** — `native/android/README.md` (setup, tests, push setup, device checklist, known gaps), root `README.md` (Android app section), `PRIVACY.md` (Android storage: Keystore, SharedPreferences, FCM/Google), `native/ios/BRIDGE.md` (Android shim, `platform`).

## Done means

- Every iOS feature has an Android counterpart, implemented and covered by JVM tests or the emulator e2e: pairing (scan, paste, link), multi-machine list sync, the full web UI with native bridge (all BRIDGE.md messages), consent, dictation, native voice mode (realtime + basic voice, undo window, push to talk, settings, personas, session switching, multi-machine), the ongoing voice notification with Mute/End, hands-free start (tile, shortcut, Answer by voice), push via the relay with local decryption, HTTPS-only origins.
- `./gradlew assembleDebug assembleRelease testDebugUnitTest lint` green; `scripts/e2e.sh` green on the emulator; `npm test` and `npm run typecheck` green.
- Device-only behaviour (locked-screen voice, Bluetooth routing, headset button mute, real FCM) is marked `[verify]` in code and listed in the README device checklist.

## Risks

- Starting a microphone foreground service from the background is refused on Android 12+/14+: the tile always opens the app (`startActivityAndCollapse`) and starts voice there; a refused start ends voice mode with "Open pi to start voice mode." [verify].
- Headset button mute during `MODE_IN_COMMUNICATION` (MediaSession) is unverified [verify].
- QuickJS JNI on the JVM test host must match the Mac's architecture (quickjs-kt ships macOS arm64/x64).
