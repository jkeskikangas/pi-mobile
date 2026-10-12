# pi for Android

The native Android app: the web UI in a `WebView`, plus what the web can't do: QR pairing, voice mode that keeps going with the screen off (a microphone foreground service with an ongoing notification), dictation audio, starting voice from the Quick Settings tile or a launcher shortcut, and push notifications through the relay. It is the iOS app (`native/ios/`) ported file by file, adjusted for Android. Plan: [`plans/native-android.md`](../../plans/native-android.md) (decisions A1–A15 on top of [`plans/native-apps.md`](../../plans/native-apps.md)). Web ↔ native contract: [`native/ios/BRIDGE.md`](../ios/BRIDGE.md), implemented unchanged.

| | |
|---|---|
| `applicationId` / `namespace` | `dev.pi_mobile.app` (permanent once uploaded) |
| `minSdk` | 26 (Android 8.0) |
| `targetSdk` / `compileSdk` | 36: from 31 Aug 2026, new apps and updates must target Android 16 (API 36) ([Android Developers](https://developer.android.com/google/play/requirements/target-sdk)) |
| `versionCode` / `versionName` | 2 / 1.0.0 (raise `versionCode` by one for every upload) |

This folder isn't part of the npm package (`package.json` `files` lists only `bin`, `src`, `web`, `README.md` and `LICENSE`).

## Setup (macOS)

```sh
brew install openjdk@21                        # JDK 21, no sudo needed
brew install --cask android-commandlinetools   # sdkmanager, avdmanager

export JAVA_HOME="$(brew --prefix)/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
# For the emulator (e2e):
sdkmanager "emulator" "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd -n pi36 -k "system-images;android-36;google_apis;arm64-v8a"
```

Put the `export` lines in `~/.zshrc`. Android Studio is optional; it brings its own SDK and JDK. The Gradle wrapper (8.14.3) is committed: run `./gradlew`, no Gradle install needed.

```sh
cd native/android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Tests

```sh
cd native/android
./gradlew testDebugUnitTest        # JVM and Robolectric tests, no emulator
./gradlew lint                     # warnings are errors (below)
./scripts/integration.sh           # FixtureHubIntegrationTest against the `npm run ui` fixture hub (no emulator)
./scripts/e2e.sh                   # the app itself on an emulator against the fixture hub
```

- **Unit tests** are ports of `native/ios/PiTests`: crypto vectors (`native/fixtures/crypto-vectors.json`), SSE parser, `HubClient` against MockWebServer, origins, machine store, prefs, push content and relay, consent, the bridge, dictation, launch requests, the voice engine, its core, host, notification and lock-screen controls.
- **Voice tests** drive `VoiceEngine` with `FakeRealtime` + `FakeHub` and the real `web/voice-core.js` from this checkout (the `pi.repo` system property), evaluated in QuickJS on the JVM (the quickjs-kt JVM jar ships macOS arm64/x64, Linux and Windows libraries). A Robolectric test checks that the copy bundled into the app's assets is that file.
- **Lint:** `warningsAsErrors`. Only `GradleDependency`, `NewerVersionAvailable` and `AndroidGradlePluginVersion` are off: versions are pinned on purpose (Packages below) and "a newer version exists" changes daily, so those would fail builds that didn't change.
- **Integration:** `scripts/integration.sh` starts `test/ui/fixture.ts` on a spare port (`PORT=`, default 7995), passes its `127.0.0.1` pairing link to the test (`-PpiPairLink`), and types `ask` into the fixture every 4 s. The test pairs through `HubClient`, calls `hub`, opens the event stream and answers the prompt. Without a link it is skipped, so plain `testDebugUnitTest` stays green offline; the script fails if it was skipped.
- **End to end:** `scripts/e2e.sh` (needs one running emulator or device) starts the fixture on port 7994, forwards it with `adb reverse` (plain HTTP to loopback is the one non-HTTPS origin the app accepts), installs the debug app and `AppE2ETest`, and revokes the microphone and notification permissions so the run starts like a fresh install. The test pairs through the debug launch extras, loads the web UI, opens voice mode (consent sheet → Allow → the microphone and notification dialogs, granted by the test → the native voice screen in basic voice) and ends it, dictates a tapped and a held take, types non-ASCII text ("Hyvää yötä, pi") into the composer above the keyboard and sends it, and checks that the menu's Notifications row comes from the app. The script fails unless the fixture logged both `transcribe` calls. Screenshots: `shots/e2e/`.
- **Screenshots:** Compose screens are captured under Robolectric (Roborazzi) into `app/build/shots`; `./gradlew testDebugUnitTest -Ppi.shots` writes the committed `shots/` instead (light and dark, large text, the voice states in `shots/voice/`).

## Voice

Every decision voice mode makes goes through `web/voice-core.js` (plan A10, D3): `VoiceCore` evaluates it in QuickJS, and **only the copy the `bundleVoiceCore` Gradle task copies from `web/` into the app's assets at build time runs**; nothing is downloaded, and the build fails if the file is missing. A newer computer stays compatible through the hub's `protocol` and `features`. `VoiceEngine` is a behaviour-for-behaviour port of the iOS engine (itself a port of `web/voice.js` `VoiceMode`). Realtime voice is WebRTC (`RealtimeClient`: the device's echo canceller and noise suppressor, a voice-communication mic, the `oai-events` data channel); without realtime it falls back to basic voice (the computer transcribes and speaks; `TextToSpeech` when it can't).

- **Every start** goes through `AppVoice` (consent, then the microphone permission) and `VoiceHost` (dictation drained, the session picked: the one that needs you, else the one used last; then the service and the engine). With voice mode already running, a start that names no session (the ongoing notification, the tile, the shortcut) only brings the voice screen forward: no pick, no network, no switch.
- **The foreground service** (`VoiceService`, type microphone) keeps voice mode running with the screen off and shows the ongoing notification: state colour, label, pi's question, elapsed time, the session, Mute/Unmute and End, a Live Update on Android 16; a tap brings the voice screen back. Android only lets a microphone service start while pi is in front, so `VoiceHost` checks right before starting it and says "Open pi to start voice mode." when Android refuses; the service catches a refusal too and ends voice mode.
- **Notifications permission:** the ongoing notification needs it on Android 13+. At the first voice mode, if Android would still show its dialog, the app says why ("Allow notifications for Mute and End from the lock screen.") and asks once; voice mode never waits for the answer.
- **Over the lock screen** (voice started from the tile or a notification, or the phone locked while the voice screen is up) the screen shows the state, the captions, pi's question (read-only: answer it by voice), Mute and End. The circle, the answer buttons, Do it now, the session switcher and settings ask to unlock first (`requestDismissKeyguard`); Cancel in the undo window works locked, since saying no is always safe. While voice mode is up the web view gets no touches and is hidden from TalkBack; a new question is announced ("pi asks: ‹title›").
- **Mute** is the phone's microphone mute, so pi lifts it when voice mode ends, and at the next start after a crash if pi had set it; a mute you set yourself stays.
- **Hands-free start:** the Quick Settings tile "Talk to pi" opens the app into voice mode and collapses the shade (lit while voice runs); the launcher shortcut "Talk to pi" (`VoiceShortcuts`) is dynamic, so the app removes it while no computer is paired and a copy pinned to the home screen says "Pair a computer first". "Answer by voice" on a notification opens that session and starts voice mode on it.

Device-only behaviour is marked `[verify]` in the code.

## Opening the app

`LaunchRequest` reads what an intent asks for once the activity is resumed (voice mode may need the consent sheet, which can only be asked then). MainActivity is exported (the launcher, the shortcut), so any app could send it extras: **a session (agent, entry, machine) is honoured only from the app's own notifications**, which reach it through the non-exported `<activity-alias>` `.app.NotificationOpen` (no other app can start that component). From anywhere else `voice=true` still opens voice mode, as the tile and shortcut do, on the session voice mode picks itself. A notification tap opens its session in the page (BRIDGE.md `focus`); **Answer by voice** opens it, dismisses the notification and starts voice mode on that session (only when the notification names its machines-list entry), and a failure reads "Voice mode didn't start: …".

Debug builds take launch extras for tests (`src/debug`, `DebugLaunch`): `piReset` forgets every computer and the consent, `piPairLink` pairs at launch. Release builds compile a stub (`src/release`) that ignores them.

## Dictation and attachments

Dictation records AAC with `MediaRecorder` (A13) and the computer transcribes it. **A take ends when pi leaves the screen** ("Dictation stopped: pi left the screen."): iOS keeps recording in the background, but Android silences the microphone of an app in the background unless a foreground service holds it, and dictation has none, so the take ends with a sentence rather than being cut off silently. The page's image input offers **Take photo** (the camera app, after the camera permission; the photo goes through a `FileProvider` cache file) or Choose photo(s) (the system photo picker), like the iOS web view.

## Push

Notifications come through the same relay as iOS (`relay/`, plan A14): `PushCenter` (package `app`) registers the FCM token at `POST <relay>/v1/register {platform: "fcm", token}` for a capability and sends `push { relay: { url, cap } }` to every paired computer. FCM delivers data-only, high-priority messages carrying `sealed`; `PiMessagingService` opens them with the matching machine's key and posts the notification itself (channels `asks` and `activity`, grouped per session; pi's questions get **Answer by voice**). A 501 from register (the relay has no FCM yet) means push isn't available yet and pauses automatic registers for 6 hours (other failures 5 minutes).

Firebase is configured from Gradle properties, without the google-services plugin. Put them in `~/.gradle/gradle.properties` (or pass `-P`):

```properties
piFirebaseProjectId=…
piFirebaseAppId=…
piFirebaseApiKey=…
piFirebaseSenderId=…
# Optional; this is the default:
piRelayUrl=https://push.pi-mobile.dev
```

Without the four Firebase values the build has no push: `push.status` answers `available: false` and the web menu says notifications aren't available in this build. The relay needs a Firebase service account with the FCM role as its `FCM_SERVICE_ACCOUNT` secret (`npx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json`, `relay/README.md`).

## Upload key

Google Play signs the app for users (Play App Signing). You sign each upload with your own **upload key**. If it's lost, Google can reset it; the app-signing key stays with Google.

```sh
cd native/android
keytool -genkeypair -v -keystore upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=pi-mobile, O=pi-mobile, C=FI"
```

Then create `native/android/keystore.properties`:

```properties
storeFile=upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

Both files are in `.gitignore` (`*.jks`, `keystore.properties`). Keep copies in your password manager. Check before every commit: `git status --ignored native/android`.

## Build the release bundle

```sh
cd native/android
./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab (signed with the upload key)
```

If `keystore.properties` is missing, the bundle is built unsigned and Play Console rejects it. Build with the Firebase properties (Push above), or the release has no notifications.

**R8.** Release builds are minified and their resources shrunk (`isMinifyEnabled`, `isShrinkResources`). `app/proguard-rules.pro` keeps what only JNI or reflection reaches: WebRTC (`org.webrtc`), QuickJS (`com.dokar.quickjs`), the kotlinx.serialization serializers, and line numbers for crash reports; libraries with their own consumer rules need nothing there. The root `build.gradle.kts` pins a newer R8 (`com.android.tools:r8:9.4.28` on the buildscript classpath) because the R8 bundled with AGP 8.13 can't read Kotlin 2.4 metadata: it warns and may shrink Kotlin classes wrongly. Drop the pin once AGP ships an R8 that knows Kotlin 2.4.

**Trying the minified build on an emulator:** `./gradlew assembleRelease -PpiReleaseDebugSigned` signs the release build with the debug key (only when no upload key is configured), so it installs with `adb install -r app/build/outputs/apk/release/app-release.apk`. Play refuses debug-signed apps; never upload it. Checked this way: the minified app pairs by pasting the link, loads the web UI and runs voice mode with its microphone service.

## Google Play

1. **Create the app:** in [Play Console](https://play.google.com/console), go to Create app, name it "pi-mobile" and choose App, Free.
2. **Play App Signing:** use the default ("Let Google manage and protect your app signing key"). Enrolment happens with the first upload; the key you upload with becomes the upload key ([Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)).
3. **Internal testing:** go to Test and release → Testing → Internal testing → Create new release, upload `app-release.aab`, add release notes, then Save → Review → Start rollout. Add testers by email list under Testers.
4. **Closed test (new personal accounts):** personal developer accounts created after 13 Nov 2023 must run a closed test with **at least 12 testers who stayed opted in continuously for at least 14 days** before they can apply for production access ([Play Console Help](https://support.google.com/googleplay/android-developer/answer/14151465)). Recruit the testers early. A tester who leaves and rejoins restarts their 14 days.
5. **Production:** Dashboard → Apply for production. You answer questions about the closed test; review usually takes up to 7 days.

Every new upload needs a higher `versionCode` in `app/build.gradle.kts`. The Data safety form should match `PRIVACY.md` (audio sent to OpenAI and your computer for voice mode, to your computer for dictation; no tracking).

## Packages (exact versions)

Toolchain: Android Gradle Plugin 8.13.0, Kotlin 2.4.10 (Compose and serialization plugins), Gradle 8.14.3, JDK 21.

| Package | Version | Why |
|---|---|---|
| androidx Compose BOM | 2025.10.00 | Native screens (Material 3, icons) |
| androidx.core:core-ktx | 1.17.0 | Notifications (promoted ongoing), compat APIs |
| androidx.activity:activity-compose | 1.11.0 | Compose in the activity, predictive back |
| androidx.lifecycle (runtime-compose, viewmodel-compose, service) | 2.9.4 | Lifecycle-aware flows |
| androidx.webkit:webkit | 1.14.0 | Document-start script and web message listener for the bridge (A7) |
| kotlinx-coroutines-android | 1.10.2 | Main-thread confinement, flows |
| kotlinx-serialization-json | 1.9.0 | `JsonElement`, the Swift `JSON` counterpart (A4) |
| com.squareup.okhttp3:okhttp | 4.12.0 | RPC, pairing, relay, the SSE stream (A5) |
| org.bouncycastle:bcprov-jdk18on | 1.82 | NaCl secretbox (XSalsa20-Poly1305), pure Java (A3) |
| io.getstream:stream-webrtc-android | 1.3.10 | Realtime voice: audio track + `oai-events` data channel, hardware AEC/NS (A9) |
| io.github.dokar3:quickjs-kt | 1.0.15 | Runs `web/voice-core.js` (A10); `quickjs-kt-jvm` for the JVM tests |
| androidx.camera (camera2, lifecycle, view) | 1.5.1 | QR pairing camera (A12) |
| com.google.mlkit:barcode-scanning | 17.3.0 | QR decoding, bundled model (A12) |
| Firebase BOM / firebase-messaging | 34.4.0 | FCM token and data messages (A14) |
| com.android.tools:r8 (buildscript) | 9.4.28 | Release minification that reads Kotlin 2.4 metadata (Build the release bundle) |
| Tests: junit 4.13.2, kotlinx-coroutines-test 1.10.2, mockwebserver 4.12.0, robolectric 4.16, androidx.test:core 1.7.0, Compose ui-test-junit4 (BOM), roborazzi 1.76.0 | | |
| Instrumented: androidx.test.ext:junit 1.3.0, runner/rules 1.7.0, uiautomator 2.3.0, espresso-web 3.7.0 | | |

## Layout

```
build.gradle.kts            plugin versions, the R8 pin
app/build.gradle.kts        dependencies, bundleVoiceCore, BuildConfig (relay URL, Firebase), R8, lint, test properties
app/proguard-rules.pro      what R8 must keep (JNI, serializers)
app/src/main/java/dev/pi_mobile/app/
  app/        PiApplication (app-scoped services), MainActivity, AppModel (machines, prefs, one HubClient per machine),
              LaunchRequest (what an intent asks), AppVoice (every voice start), PushCenter (relay registration)
  core/       Json, Envelope (secretbox), HubClient (pair, rpc, agent, SSE events), SseParser, Models, OriginPolicy (HTTPS only,
              plus loopback), MachineStore (Keystore-encrypted), Prefs, PushContent
  pairing/    PairingScreen (scan, paste, inline errors), QrScanner (CameraX + ML Kit), CameraPermission
  consent/    AIConsent (the stored OK, the gate), ConsentSheet (who receives your voice)
  shell/      WebShell (WebView, setup script, piNative shim), NativeBridge (BRIDGE.md messages), ShellScreen (loading/offline),
              ShellScripts, Permissions, NetworkWatch, ScanCenter, BridgePorts
  dictation/  Dictation (dictation.* bridge calls), AudioRecorder (MediaRecorder AAC)
  voice/      VoiceEngine (port of web/voice.js VoiceMode), VoiceCore (QuickJS), VoicePorts (seams), VoiceModels, LiveFleet + HubFleetClient,
              RealtimeClient + Levels (WebRTC), AudioSessionController, AndroidBasicAudio + BasicVoice, Earcons,
              VoiceHost (every start), VoiceService + VoiceNotification (foreground service, ongoing notification)
  voiceui/    VoiceScreen (orb, captions, question card, Mute/End), sheets, haptics, palette,
              VoiceBinding (engine → screen, VoiceRoute, lock-screen controls)
  intents/    StartVoiceTile (Quick Settings "Talk to pi"), VoiceShortcuts (the dynamic launcher shortcut)
  push/       PiMessagingService (FCM), FirebaseSetup, Notifications (Answer by voice), NotificationPermission, PushController
  ui/         Theme (the web's tokens), Components, Motion
app/src/debug/              DebugLaunch (test launch extras), VoiceFixtures (voice screen previews and shots)
app/src/release/            DebugLaunch stub (no launch extras in release)
app/src/test/               JVM and Robolectric tests (ports of PiTests), screenshot tests
app/src/androidTest/        AppE2ETest (scripts/e2e.sh)
scripts/                    integration.sh, e2e.sh
shots/                      committed screenshots (screens, voice/, e2e/)
```

## Notes

- **Machines** live in private SharedPreferences (`pi-secure`, key `machines`) as `[{ id, machine, name, origin, d, k, primary, added, lastSeen }]`, encrypted with AES-256-GCM under an AndroidKeyStore key (`pi-machines`, no user authentication, so voice works with the screen locked) (A6). Backup is off (`allowBackup=false`): a restored copy couldn't be decrypted anyway. The page's `localStorage` copy is rewritten at every load (BRIDGE.md).
- **HTTPS only** (A5). The app accepts only `https://` computers: when pairing, for computers the web adds, in `HubClient` (RPC, events, push registration) and in the web shell. The one exception is plain HTTP to loopback (`127.0.0.1`, `localhost`, `::1`) so the emulator reaches the fixture through `adb reverse`. A plain-HTTP link (LAN, Tailscale `100.x`, `.local`) gets "This computer needs its secure address" with the steps. `OriginPolicy` holds the rule; hub requests also refuse redirects off their own origin (`RedirectGuard`).
- **Consent** (Google Play User Data policy): before the first voice mode or dictation, `ConsentSheet` says who receives what (voice mode: OpenAI realtime via the computer's ChatGPT sign-in or API key, and the computer; dictation: the computer). Allow / Not now. The answer is stored as `AIConsent.VERSION` (2) in prefs (`pi-ai-consent`); bump it when the recipients change and everyone is asked again. Starts that can't show the sheet (tile, notification with the app in the background) open the app to ask. Revoke: voice settings → Stop sharing my voice, or the web menu (BRIDGE.md `consent.*`).
- **Permissions** are asked when used: the camera on the scan button and for Take photo (`CameraPermission`: ask → rationale → Open settings), the microphone after the consent sheet at the first voice mode or dictation (once only Settings can turn it back on, the app offers to open them), notifications at the first voice mode (once, for Mute and End on the lock screen) and from the menu's Turn on notifications (`NotificationPermission`).
- **Privacy:** `PRIVACY.md` at the repo root (including the Android storage and FCM through Google), linked from the pairing screen, the consent sheet and voice settings.

## Device checklist [device]

None of these have run on a real phone yet: everything above is checked on the JVM, under Robolectric or on the emulator only. Fill in the Result column (date, phone model, Android version) as you go.

| Check | Result |
|---|---|
| Scan the `/remote` code: the haptic fires and the web UI opens already paired. | not yet run on device |
| Deny the camera: the pairing screen offers Open settings and pasting the link. | not yet run on device |
| Turn off the computer's hub: the app shows "Can't reach ‹name›" with Try again, never a WebView error page. | not yet run on device |
| Light and dark: no white flash on launch or reload; edge to edge with the system bars. | not yet run on device |
| The full web UI works: sessions, sending, answering a question, images. | not yet run on device |
| Voice mode answers a question with the screen off (phone in a pocket). | not yet run on device |
| The undo-window and "stop" scenarios from `docs/voice.md` → Verification behave as on the web. | not yet run on device |
| A 30-minute voice session with the screen off keeps going (events, status, the realtime call; the service and wake lock hold). | not yet run on device |
| Speakerphone barge-in: pi's own voice is not heard as you (hardware AEC through `JavaAudioDeviceModule`). | not yet run on device |
| Bluetooth headset connected: voice goes through it; disconnect mid-session: audio moves to the speaker and voice keeps going. | not yet run on device |
| Wired or USB headset: chosen over the speaker; unplugged: back to the speaker. | not yet run on device |
| Headset button (play/pause) acts like tapping the circle. | not yet run on device |
| The ongoing notification shows the state, question and elapsed time; Mute/Unmute and End work; a tap brings the voice screen back without switching session; it is a Live Update chip on Android 16. | not yet run on device |
| First voice mode on Android 13+: the notification permission is asked once with its reason; denying it still starts voice. | emulator (e2e grants it); device not yet run |
| Locked phone with voice mode up: only the state, captions, the question, Mute and End act; the circle, answers, switcher and settings ask to unlock; a spoken answer works. | not yet run on device |
| Quick Settings "Talk to pi": opens the app into voice mode and collapses the shade, unlocked and from the lock screen (Android 14, 15, 16); lit while voice runs. | not yet run on device |
| Launcher shortcut "Talk to pi" opens voice mode; with no computer paired it is gone (a pinned copy says "Pair a computer first"). | not yet run on device |
| Voice started from the lock screen shows over it and turns the screen on. | not yet run on device |
| A phone call interrupts: voice pauses and resumes after, or offers "Tap to resume"; the audio route comes back to the headset. | not yet run on device |
| Mute, then a crash or force stop: the next start lifts the phone's microphone mute. | Robolectric; device not yet run |
| Earcons are heard over the realtime audio, one after another; pi's voice ducks while you talk. | not yet run on device |
| Basic voice: the computer's voice plays, the orb follows its level; without server speech the phone's TextToSpeech speaks in the persona's voice. | not yet run on device |
| Wi-Fi ↔ mobile data mid-session: events reconnect and the call redials; another Wi-Fi doesn't redial. | not yet run on device |
| Dictation gives the distilled text; music pauses for it and resumes after (audio focus); switching apps mid-take ends it with "Dictation stopped: pi left the screen." | emulator (e2e: tap and hold takes); device not yet run |
| Take photo in the attachment picker: the camera app opens and the photo is attached. | not yet run on device |
| The composer stays above the keyboard and takes non-ASCII text. | emulator (e2e); device not yet run |
| With Firebase configured: a push shows the session and text (opened on the phone); tapping opens that session; **Answer by voice** dismisses it and starts voice there. | not yet run on device (needs a Firebase project and the relay's FCM secret) |
| A Tailscale HTTPS (`https://….ts.net`) hub loads; a plain-HTTP link is refused with the secure-address hint. | unit tests; device not yet run |
| First voice mode and first dictation show the consent sheet; Not now starts nothing; Stop sharing my voice asks again. | emulator (e2e: voice); device not yet run |
| The minified release build (R8) pairs, loads the web UI and runs voice mode. | emulator (`-PpiReleaseDebugSigned`); device not yet run |

## Known gaps

- Nothing is verified on a real phone yet (checklist above). Code that depends on device behaviour is marked `[verify]`:
  - **Echo cancellation:** the hardware AEC/NS in WebRTC's audio module, the `AcousticEchoCanceler` on basic voice's `AudioRecord`, and whether earcons played as voice communication are cancelled away.
  - **Levels:** whether WebRTC stats carry the mic's `audioLevel` (`media-source`), which the client VAD and the orb depend on; the display scaling; the `Visualizer` level for the computer's audio.
  - **Volume:** the remote track's ducking gain (`AudioTrack.setVolume`, 1 = unity).
  - **Lost calls:** a WebRTC disconnect counts as lost after 10 s; whether WebRTC recovers from a network change by itself (the engine redials anyway).
  - **Headset button:** a `MediaSession` that claims to play, during communication mode.
  - **Tile:** a microphone foreground service can't start from the background on Android 14+, so the tile opens the app, which starts voice once in front; the refusal paths (service start refused, `startForeground` refused) are tested only as code paths.
  - **Lock screen:** showing the voice screen over it, turning the screen on, and the unlock prompt for the limited controls.
- Dictation can't continue in the background (no foreground service for it): a take ends when pi leaves the screen; iOS keeps recording.
- The phone's TextToSpeech can't pause: when pi ducks for you, local speech stops and repeats the current sentence on unduck (iOS pauses mid-word).
- A permanent audio-focus loss (another app takes the audio) pauses voice mode until a tap; a temporary one resumes by itself.
- Voice mode uses the `voice-core.js` bundled in the app, which can lag a newer computer's web UI until the app is updated.
- The ChatGPT-sign-in realtime endpoint is undocumented and may change; voice then uses basic voice, which the app supports.
- The app is HTTPS only: a computer needs a secure address (Tailscale Serve via `/remote`, or your own HTTPS URL), even on the home Wi-Fi.
- Push needs a Firebase project and the relay's `FCM_SERVICE_ACCOUNT`; a build without the Firebase properties has none.
- No Android Auto UI and no Assistant App Actions (A11); hands-free start is the tile, the shortcut and Answer by voice.
- The R8 pin (`com.android.tools:r8:9.4.28`) is a workaround until AGP bundles an R8 that reads Kotlin 2.4 metadata.
- No Play Store release yet (closed test first, Google Play above).
