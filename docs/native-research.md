# Native companion app for pi-mobile voice: research (2026-10-10)

**[verify]** marks a claim that needs a device or account test, or that comes from a secondary or truncated source.

## iOS

### 1. Background mic and playback
- **Setup.** Add `UIBackgroundModes: audio` and use `AVAudioSession` category `.playAndRecord`. Background audio is allowed only for its real purpose: App Review guideline 2.5.4 lists "audio playback, VoIP…". A live two-way voice conversation qualifies; keeping a socket alive with silence does not. https://developer.apple.com/app-store/review/guidelines/ · https://developer.apple.com/documentation/xcode/configuring-background-execution-modes
- **Mode.** Use `.voiceChat`, which turns on the system voice-processing path (AEC/AGC). WebRTC sets this itself through `RTCAudioSessionConfiguration.webRTC()`. `.default` loses hardware AEC on the speaker route.
- **Options.** `.allowBluetoothHFP` is the new name for `.allowBluetooth`, which Xcode 26 deprecates; both are the same value, `0x4`. Add `.defaultToSpeaker`, so audio doesn't come out of the earpiece. `.allowBluetoothA2DP` is output-only and irrelevant when the mic is in use, because HFP wins. iOS 26 also adds a high-quality AirPods recording option, aimed at content creation rather than calls. https://forums.swift.org/t/xcode-26-avaudiosession-categoryoptions-allowbluetooth-deprecated/80956 · https://developer.apple.com/videos/play/wwdc2025/251/
- **Activation timing.** Activate the session and get IO running while the app is in the foreground. A suspended app cannot later activate a recording session by itself; the only exceptions are an `AudioRecordingIntent` (§3) and a CallKit call. Running IO is what keeps the app alive in the background.
- **Interruptions.** Handle `AVAudioSession.interruptionNotification` for phone calls, Siri and alarms. On `.ended`, re-activate, and resume only if `.shouldResume` is set; otherwise show "tap to resume". Handle `routeChangeNotification` too (AirPods connect or disconnect, CarPlay). With WebRTC, let `RTCAudioSession` own these notifications and forward them to its delegate rather than also running your own handler. **[verify]** whether our own interruption handling is needed beyond RTCAudioSession's.
- **Review risk.** It is low as long as the mic is only live during a user-visible session; show a Live Activity or Now Playing info for it. iOS shows the orange mic indicator regardless.

### 2. WebRTC on iOS for OpenAI realtime
- **Binaries.** Google publishes no official iOS binaries; the GoogleWebRTC pod ended at M80.
  - **stasel/WebRTC** (SPM, upstream Google source, about M151 now) is the common choice for a plain `RTCPeerConnection`. https://github.com/stasel/WebRTC · field report: https://getxtend.com/blog/webrtc-ios-without-video-call.html
  - **livekit/webrtc-xcframework** has `LK`-prefixed symbols and an AVAudioEngine-based audio device module. One report says it receives no video on iOS 26 because of a BUNDLE demux bug (M137); audio was fine. https://github.com/livekit/webrtc-xcframework · https://github.com/livekit/client-sdk-swift/issues/909
  - **Recommendation:** stasel M14x+, audio plus one data channel (`oai-events`), the same SDP flow as the web app.
- **Echo cancellation.** The default iOS audio device module uses the `VoiceProcessingIO` audio unit, so you get Apple's hardware AEC/AGC/NS while the session is in `.voiceChat`. LiveKit exposes this as AEC/NS/AGC modes, "platform (VPIO) vs software". https://github.com/livekit/client-sdk-swift/blob/main/Docs/audio.md
- **Audio levels.** Two options:
  - `peerConnection.statistics` gives `audioLevel` / `totalAudioEnergy` in `media-source` (mic) and `inbound-rtp` (model voice). Polling every 100 ms is fine for a level meter.
  - For per-buffer levels, attach an `RTCAudioRenderer`/sink to the remote track, or tap the audio device module. **[verify]** that the stasel build exposes a remote audio sink.
- **RTCAudioSession.** It wraps AVAudioSession. Set `useManualAudio = true` and keep `isAudioEnabled = false` until you have configured and activated the session yourself (`lockForConfiguration`, `setCategory`, `setActive`). Then set `isAudioEnabled = true` to start the audio unit. Setting it back to `false` stops capture and playback; you can use that for hold. CallKit apps call `audioSessionDidActivate` / `audioSessionDidDeactivate`. https://webrtc.googlesource.com/src/+/main/sdk/objc/components/audio/RTCAudioSession.h
- **Background.** WebRTC media keeps flowing in the background as long as the audio unit runs and `audio` mode is declared. Idle data-only peer connections are suspended in about 30–60 s (https://community.livekit.io/t/react-native-voice-session-terminating-in-background/945). Our encrypted RPC socket to the hub stays alive only because audio is running. Plan an ICE restart and an RPC reconnect for network changes.
- **OpenAI SDKs.** OpenAI ships no official Swift realtime SDK. Its docs cover browser WebRTC and WebSocket (https://developers.openai.com/api/docs/guides/realtime-webrtc). Community options: `m1guelpf/swift-realtime-openai` (WebRTC + WebSocket), `PallavAg/VoiceModeWebRTCSwift` (sample app), and the Pipecat iOS `OpenAIRealTimeWebRTCTransport`. Use them as references; our SDP-via-hub flow is custom anyway. https://github.com/m1guelpf/swift-realtime-openai · https://github.com/PallavAg/VoiceModeWebRTCSwift · https://docs.pipecat.ai/api-reference/client/ios/transports/openai-webrtc
- **WebSocket transport as an alternative.**
  - With an API key: `wss://api.openai.com/v1/realtime?model=…`, authenticated with a backend-minted ephemeral secret (`POST /v1/realtime/client_secrets`) sent as `Authorization: Bearer`.
  - Downsides: you send and receive base64 PCM16 yourself, there is no built-in AEC (you need your own VPIO unit or AVAudioEngine with `setVoiceProcessingEnabled(true)`), and you handle jitter and truncation yourself.
  - With ChatGPT OAuth, codex uses only the WebRTC `/backend-api/codex/realtime/calls` path plus a sideband WebSocket keyed by `call_id`. **[verify]** that a pure-WebSocket ChatGPT-OAuth path exists; assume it doesn't.
  - Verdict: keep WebRTC, which matches the web app and gets AEC for free.

### 3. Hands-free start
- **App Intents.** An `AppShortcutsProvider` phrase gives Siri, Shortcuts, Spotlight and the Action button with no setup. iOS 18+ `ControlWidget` (Control Center, Lock Screen, Action button) can run the same intent.
- **AudioRecordingIntent (iOS 18+).** Apple's documentation says: *"you must start a Live Activity when you begin the audio recording and keep it active as long as you record audio. If you don't start a Live Activity, the audio recording stops."* https://developer.apple.com/documentation/appintents/audiorecordingintent
- **Background start in practice.** Field evidence from hex-iphone:
  - Starting the Live Activity from a background launch can fail with "Target is not foreground". Recording with no Live Activity gets the process hard-killed.
  - Their working pattern: `AudioRecordingIntent` + `ForegroundContinuableIntent` with `openAppWhenRun = false`. Try headless; if `Activity.request` fails, call `requestToContinueInForeground()` and retry.
  - https://github.com/Luraxx/hex-iphone/commit/ac1a72ccc448b0da8deca7946db5581474daf2b0 · earlier fallback https://github.com/Luraxx/hex-iphone/commit/6fff87f3ad27299822c031098ae3359cf926a92e · forum https://developer.apple.com/forums/thread/816408 **[verify on iOS 26/27]**
- **Verdict.**
  - With the phone locked, starting the mic without opening the app is possible but unreliable.
  - Design for (a) a headless attempt plus a foreground fallback, and (b) once a session is live, everything (mute, stop, new turn) works in the background through intents, the Live Activity buttons (`LiveActivityIntent`) and the AirPods controls.
  - Starting through the Action button or a Control while unlocked is the reliable path.

### 4. Live Activities / Dynamic Island
- **Local updates.** While background audio keeps the app executing, `activity.update(...)` works locally, so no APNs is needed during a voice session. The app must start the Live Activity in the foreground (or via push-to-start, iOS 17.2+).
- **Push updates** (`apns-push-type: liveactivity`, topic `<bundle>.push-type.liveactivity`, token from `pushTokenUpdates`) cover updates while the app is suspended, e.g. "agent finished" after the voice session ends.
  - Priority-10 pushes count against an unpublished budget; priority 5 doesn't. `NSSupportsLiveActivitiesFrequentUpdates` raises the budget.
  - Activities last up to 8 h active, plus up to 4 h on the Lock Screen afterwards. The ActivityKit payload limit is 4 KB.
  - https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- `LiveActivityIntent` buttons (mute, end) run in the app's process without opening it.

### 5. CarPlay
- **Category.** iOS 26.4 added a **"Voice-based conversational apps"** CarPlay category, first in the Feb 2026 guide; the current guide is dated 2026-06-08. https://9to5mac.com/2026/02/18/ios-26-4-adds-support-for-voice-based-ai-apps-to-carplay/ · https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf · WWDC26 "Rev up your CarPlay app" https://developer.apple.com/videos/play/wwdc2026/212/
- **Rules.**
  - The app's primary modality must be voice.
  - Hold the audio session open only while voice is actively in use.
  - Avoid showing text or imagery in responses.
  - The general rules still apply: no gaming or social apps, and never show message content.
  - Recording is allowed only for navigation and voice-conversational apps.
- **Templates.** Same set as driving-task apps: List, Grid, Tab bar, Action sheet, Alert, and `CPVoiceControlTemplate` (iOS 26.4+; up to 2 action buttons). Hierarchy depth is limited to 3.
- **Entitlement.** `com.apple.developer.carplay-voice-based-conv…` (the string is truncated in the PDF **[verify]**). Request it at developer.apple.com/contact/carplay; you need a paid account and a review against the criteria.
- **Fit.** A coding-agent voice front end plausibly fits: voice-first, with a status-only UI. Approval odds for an individual developer: **[verify]**.
- **Without CarPlay.** Even with no CarPlay entitlement, audio routes through the car via the phone's session, and the Live Activity appears on CarPlay ("CarPlay supports Live Activities… from any app", WWDC26).

### 6. AirPods and headset controls
- **Mute gesture (iOS 17+).** Non-CallKit apps opt into AirPods "press to mute" by observing `AVAudioApplication.inputMuteStateChangeNotification` and keeping state in sync with `AVAudioApplication.shared.setInputMuted(_:)`. iOS mutes the uplink, plays a tone and notifies the app. CallKit apps get this automatically. https://developer.apple.com/videos/play/wwdc2023/10233/ · https://developer.apple.com/documentation/avfaudio/avaudioapplication/setinputmuted(_:)
  - Mirror the state to WebRTC with `audioTrack.isEnabled = !muted`, to be safe.
  - **[verify]** whether it requires `.voiceChat` mode and whether VPIO honours the mute.
- **MPRemoteCommandCenter.** play/pause/togglePlayPause events arrive only if the app is the "Now Playing" app. With `.playAndRecord` + `.voiceChat` in the HFP route, a stem press is usually the mute gesture rather than play/pause. Use mute = stem press; optionally map `togglePlayPauseCommand` to "end turn / interrupt". **[verify]** on device.
- **CallKit.** Treating the session as a call would give a lock-screen call UI, the mute gesture, and higher audio priority. Apple rejects CallKit for non-calls (and China disallows it), so skip it.

### 7. Push without our own server
- APNs token auth means: an ES256 JWT signed with the `.p8` (kid = Key ID, iss = Team ID; refresh every 20–60 min), sent over HTTP/2 to `api.push.apple.com` / `api.sandbox.push.apple.com` as `POST /3/device/<token>`.
- Node's built-in `node:http2` + `crypto` (or `@parse/node-apn`, `apns2`) does it in about 60 lines. It is fully feasible from the hub on the user's machine. https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns · https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- **Catch: the `.p8` is per team.** For a self-built app, the user's own team key works. For an App Store / TestFlight app we publish, every user's hub would need *our* key, which is unacceptable. That needs a tiny relay we operate (it only forwards opaque, encrypted payloads), or ntfy.sh / Pushover-style apps.
- **Alternatives.** Background audio covers the voice session itself. Local notifications can be scheduled while the app is running.

### 8. Crypto (tweetnacl compatibility)
- CryptoKit has no XSalsa20; its ChaChaPoly is IETF ChaCha20-Poly1305, not compatible with secretbox.
- Use **swift-sodium** (libsodium; `secretBox.seal/open` is XSalsa20-Poly1305 and wire-compatible with `nacl.secretbox`). Note that it puts the nonce in front by default, so match the framing. https://github.com/jedisct1/swift-sodium
- Lighter option: `bitmark-inc/tweetnacl-swiftwrap`. https://github.com/bitmark-inc/tweetnacl-swiftwrap
- `box` (Curve25519) is also in libsodium.

### 9. Distribution
- **Free Personal Team:** profiles expire after 7 days, with a small device and app-ID cap. No Push Notifications capability, so no APNs and no push-updated Live Activities. CarPlay is impossible. Local Live Activities and background audio do work **[verify]**. https://developer.apple.com/help/account/reference/supported-capabilities-ios
- **Paid ($99/yr):** 1-year profiles, TestFlight (90-day builds, internal testers need no review), APNs, and the CarPlay entitlement request.
- **EU alternative marketplaces / web distribution** still need a paid account and notarization.
- **Review notes.** Explain the background audio use ("live two-way voice session with user's coding agent; mic active only while the session and Live Activity are visible"). Supply a demo account or video. Note that the app needs a paired desktop host.

## Android

### 10. Foreground service, WebRTC, media buttons, Android Auto
- **FGS type.** Use `foregroundServiceType="microphone"` with `FOREGROUND_SERVICE_MICROPHONE` + `RECORD_AUDIO`; add `mediaPlayback` too if you want the playback semantics.
  - `RECORD_AUDIO` is while-in-use, so you **cannot create a microphone FGS from the background, even with the usual background-start exemptions**. Start it from a visible activity, a notification action the user taps, or a tile/widget tap. **[verify]** which of those count as "visible" on 15/16.
  - Once started, it survives screen-off and backgrounding.
  - https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start · https://developer.android.com/develop/background-work/services/fgs/service-types
  - Play policy needs an FGS declaration. https://support.google.com/googleplay/android-developer/answer/13392821
- **WebRTC libraries.**
  - `io.getstream:stream-webrtc-android`: plain `org.webrtc`, maintained, Compose helpers. https://github.com/GetStream/webrtc-android
  - `io.github.webrtc-sdk:android`, the LiveKit fork. LiveKit's own SDK is room-oriented, so don't use it.
  - Use `JavaAudioDeviceModule` with `setUseHardwareAcousticEchoCanceler(true)` / `setUseHardwareNoiseSuppressor(true)`. Its source is `VOICE_COMMUNICATION`, which triggers platform AEC.
  - Set `AudioManager.mode = MODE_IN_COMMUNICATION`. On API 31+, route with `setCommunicationDevice()` for BT SCO, speaker or earpiece.
  - AEC quality varies by OEM; WebRTC's software AEC3 is the fallback.
- **Headset buttons.** A `MediaSession` (media3 `MediaSessionService`) receives media buttons only while it is the active, playing session. During communication mode, BT headset hook/mute often goes to Telecom instead. A self-managed `ConnectionService` would deliver mute/hangup but makes the session look like a call. **[verify]**
- **Android Auto.** The supported categories are media, messaging/communication (templated messaging and calling are in labs), navigation, POI, IoT, weather and games. **There is no third-party voice-assistant or conversational category.**
  - Options: audio routes through the car automatically, plus a notification. Or abuse "media", which Play would likely reject. Templated "calling" (labs) is the nearest fit. **[verify]**
  - https://developer.android.com/training/cars · https://developer.android.com/docs/quality-guidelines/car-app-quality
- **Hands-free start.** Quick Settings tile, home-screen widget, app shortcut, and "Hey Google, open X" (App Actions / Gemini extensions are in flux). All of these must bring up UI or a tapped notification before the mic FGS can start.

## Cross-platform

### 11. Capacitor / React Native / Flutter
- **All three still need native code for the hard parts:** session category and options, interruptions, the mute gesture, AudioRecordingIntent + Live Activity (Swift-only widget extension), CarPlay, and the Android mic FGS.
- **WebRTC per framework:**
  - React Native: `react-native-webrtc` works, but background needs your own FGS on Android (issue #1780: the mic stops after about 5 s in the background) and the `audio` mode on iOS.
  - Flutter: `flutter_webrtc` has open background-audio bugs (issue #1005).
  - Capacitor: no first-class native WebRTC; WKWebView WebRTC stops when the app is backgrounded.
- **Links:** https://github.com/react-native-webrtc/react-native-webrtc/issues/1780 · https://github.com/flutter-webrtc/flutter-webrtc/issues/1005 · https://community.livekit.io/t/react-native-voice-session-terminating-in-background/945
- **Recommendation:** the voice companion is mostly audio, system integration and small status UI. Go **native Swift (SwiftUI) first**, with a later Kotlin app. Share protocol and crypto test vectors, not code. The existing web app stays the full UI.

## Decisions (recommended)
1. **iOS-native Swift/SwiftUI app**, voice-only scope: pair → session → Live Activity → controls. The web PWA remains the main UI.
2. **WebRTC: stasel/WebRTC via SPM.** Reuse the existing flow: create the offer, send it over the encrypted RPC, the hub posts it to `chatgpt.com/backend-api/codex/realtime/calls`, and the answer comes back. Use the `oai-events` data channel for events. No WebSocket transport.
3. **Audio session:** `RTCAudioSession.useManualAudio = true`; `.playAndRecord` + `.voiceChat` + `[.allowBluetoothHFP, .defaultToSpeaker]`. Activate in the foreground, then `isAudioEnabled = true`. Rely on VPIO for AEC. Handle interruptions and route changes, and resume only on `.shouldResume`.
4. **Background:** `UIBackgroundModes: audio`. While the session is live, keep the RPC socket alive and update the Live Activity locally. Do an ICE restart and RPC reconnect on network change.
5. **Hands-free:** `StartVoiceIntent: AudioRecordingIntent, ForegroundContinuableIntent`, exposed through App Shortcuts (Siri phrase), a ControlWidget (Control Center / Action button) and Shortcuts. Try headless, and fall back to `requestToContinueInForeground`. Always start the Live Activity before the mic.
6. **Controls:** AirPods mute through the `AVAudioApplication` input-mute notification + `setInputMuted`, mirrored to `track.isEnabled`. Live Activity buttons via `LiveActivityIntent` (mute, end). No CallKit.
7. **Levels:** poll `RTCStatsReport` `audioLevel` (media-source / inbound-rtp) every 100 ms for the UI and the Dynamic Island.
8. **Crypto:** swift-sodium `secretBox`, with cross-language test vectors from tweetnacl-js.
9. **Push:** v1 has no APNs; background audio covers the session. In v2, the hub sends APNs directly with a user-supplied `.p8` if the user self-builds. For a TestFlight build, add an optional minimal relay that forwards encrypted blobs.
10. **Distribution:** a paid developer account plus TestFlight. Free 7-day provisioning works only for the developer's own device, with no push.
11. **CarPlay:** a later phase. Apply for the voice-based conversational entitlement (iOS 26.4+) using `CPVoiceControlTemplate` + List. Until then, car audio routing and the Live Activity on CarPlay come for free.
12. **Android (later):** Kotlin + stream-webrtc-android. Start the `microphone` FGS from a visible UI or a tapped notification or tile. Use `MODE_IN_COMMUNICATION` + `setCommunicationDevice` and hardware AEC. No Android Auto UI.

## Top on-device verification list
- Headless AudioRecordingIntent start from the Action button or a Control while locked, on iOS 26/27.
- AirPods press-to-mute delivered to a non-CallKit `.voiceChat` WebRTC app.
- Background survival over 30 min with the screen locked, including the hub RPC socket.
- Exact CarPlay entitlement key and approval feasibility.
