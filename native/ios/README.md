# pi for iOS

The native iOS app: the web UI in a `WKWebView`, plus what the web can't do: QR pairing, voice mode that keeps going with the screen locked, dictation audio, a Live Activity, starting voice from the Action button or Siri, and push notifications. Plan: `plans/native-apps.md`. Web ↔ native contract: `BRIDGE.md`.

## Setup

You need Xcode 26.6 with the iOS 26.5 platform (`xcodebuild -downloadPlatform iOS`) and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd native/ios
xcodegen                      # writes Pi.xcodeproj from project.yml (not committed)
open Pi.xcodeproj
```

To run on your own iPhone, set these build settings in `project.yml` (`settings.base`) and run `xcodegen` again, or pass them to `xcodebuild`:

| Setting | Default | Set it to |
|---|---|---|
| `DEVELOPMENT_TEAM` | empty | Your team ID (Xcode → Settings → Accounts, or Membership details on developer.apple.com). A free Personal Team works, without push. |
| `PI_BUNDLE_PREFIX` | `dev.pimobile` | A reverse-DNS prefix you own, e.g. `com.example`. The app is `<prefix>.pi`, the extensions `<prefix>.pi.widgets` and `<prefix>.pi.notifications`, the shared Keychain group `<prefix>.shared`. Use the app's id as the bundle ID in `/remote settings` → iPhone push. |
| `PI_PUSH` | `NO` | `YES` with a paid team: signs with `Pi/App/PiPush.entitlements` (push capability). See Push below. |

Signing is automatic: Xcode makes the profiles on the first run. Apps from a free team stop opening after 7 days; run again from Xcode to renew. `PI_WIDGETS` is not a setting and has nothing to do with signing or provisioning: it is a compile guard (`#if PI_WIDGETS`) that keeps app-only code out of the `PiWidgets` extension, which compiles the intent files too.

## Tests

Always pass `-project Pi.xcodeproj`, so the command never depends on what else is in the folder.

```sh
cd native/ios
xcodegen
xcodebuild test -project Pi.xcodeproj -scheme Pi -destination 'platform=iOS Simulator,name=iPhone 16'
./scripts/integration.sh      # PiIntegrationTests against the `npm run ui` fixture hub
./scripts/e2e.sh              # PiUITests (scheme PiE2E): the app itself against the fixture hub
```

`name=iPhone 16` resolves to the newest OS, so create an iPhone 16 on 26.5 if only older runtimes have one: `xcrun simctl create "iPhone 16" com.apple.CoreSimulator.SimDeviceType.iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-26-5`. Both scripts take `DEST=` (e.g. `platform=iOS Simulator,id=<udid>`); `e2e.sh` also takes `DERIVED=` for the derived-data folder.

Release builds can fail where Debug doesn't (the Debug-only launch arguments are compiled out). Before shipping, also build `xcodebuild build -project Pi.xcodeproj -scheme Pi -configuration Release -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO`, and the `PiWidgets` and `PiNotifications` schemes the same way.

### Integration test

`scripts/integration.sh` starts `test/ui/fixture.ts` on port 7989, passes its `127.0.0.1` pairing link to the test as `TEST_RUNNER_PI_PAIR_LINK`, and types `ask` into the fixture every 4 s. The test pairs through `HubClient`, calls `hub`, opens the event stream, sees `hello` and `info`, answers the confirm prompt and waits for its `prompt_end`. Without a link the test is skipped, so the plain `xcodebuild test` stays green offline.

### End to end in the simulator

`scripts/e2e.sh` starts the fixture on port 7993 and runs `PiUITests/AppE2ETests` (skipped without a link). The app pairs with `-PiPairLink`; the web UI loads; the voice button first shows the consent sheet (the test taps Allow), then opens the native voice screen, which says "Using basic voice. Details in voice settings." (the fixture has no realtime voice); End returns to the web UI; a tapped and a held dictation take each reach the fixture's `transcribe`; the menu says notifications aren't available in this build (no `PI_PUSH`), not the web's Home Screen note, and offers Stop sharing my voice. The script fails unless the fixture logged both `transcribe` calls. Screenshots: `shots/e2e/`.

### Screenshots

Debug builds accept launch arguments for the simulator, which has no camera: `-PiReset` forgets every computer, `-PiPairLink <link>` pairs at launch, `-PiAssumeScanner` shows the scan button, `-PiFakeVoice <state>` shows the voice screen and Live Activity in that state (with `-PiFakeMuted`, `-PiFakeMachine`), `-PiPushDemo '<APNs JSON>'` runs the notification rewrite (Push below). Current shots: `shots/` (`voice/`, `activity/`, `push/`, `e2e/`).

## Push (needs a paid team)

Notifications come from each computer over APNs (`src/apns.ts`, set up with `/remote settings`). Apple sees only "pi · New activity"; the `PiNotifications` Notification Service Extension opens the `sealed` field with the matching device key from the shared Keychain group and rewrites the title and body (no key: the generic text stays). Urgent ones (pi asks) get the `pi.asks` category with **Answer by voice**; a tap opens that session (`focus` in BRIDGE.md).

Free provisioning has no push capability, so the default build leaves `aps-environment` out; `PI_PUSH` also reaches Info.plist as `PiPushAvailable`, and without it `push.status` answers `available: false`, so the web menu says notifications aren't available in this build instead of offering a setup that can't work. With a paid team build with `PI_PUSH=YES` (e.g. `xcodebuild … PI_PUSH=YES DEVELOPMENT_TEAM=XXXXXXXXXX`, or set it in `project.yml`): the app then signs with `Pi/App/PiPush.entitlements` (`aps-environment` development for Debug, production for Release, plus time-sensitive). The token's `sandbox` flag follows the same `PI_APS_ENVIRONMENT` (Info.plist `PiAPSEnvironment`). The hub sends no `thread-id` (it would show Apple the session id); the extension groups by the sealed machine and session. Turning notifications off is retried at each launch and foreground until every computer's `hub` reports `apnsOn: false`. `Pi/App/Pi.entitlements` and `PiPush.entitlements` are hand-written (not generated by XcodeGen): keep their keychain groups in sync.

Simulator check (no APNs needed): the simulator never runs a service extension for `xcrun simctl push`, so that shows only the generic text (`shots/push/generic.png`). The Debug launch argument `-PiPushDemo '<APNs JSON>'` runs the extension's rewrite (`PushContent`, same Keychain lookup) in the app and posts the result locally (`shots/push/rewritten.png`); seal the payload with the device key from the hub's `devices.json` (`seal` + `apnsPayload` in `src/`). Permission comes from the menu's Turn on notifications. [device] With `PI_PUSH=YES`, a real sandbox push runs `PiNotifications` itself.

## Packages (exact versions)

| Package | Version | Why |
|---|---|---|
| [jedisct1/swift-sodium](https://github.com/jedisct1/swift-sodium) | 0.11.0 | secretbox (XSalsa20-Poly1305), wire-compatible with tweetnacl-js (plan D6) |
| [stasel/WebRTC](https://github.com/stasel/WebRTC) | 154.0.0 | realtime voice (plan D4): audio track + `oai-events` data channel |

## Layout

```
project.yml           XcodeGen spec: Pi, PiWidgets, PiNotifications, PiTests, PiIntegrationTests, PiUITests; schemes Pi and PiE2E
Pi/App/               PiApp, AppModel (machines, prefs, one HubClient per machine), PushCenter, Info.plist, entitlements
Pi/Core/              JSON, Envelope (sodium), HubClient (pair, rpc, agent, SSE events), SSEParser, Models, Keychain (+ MachineStore), PushContent,
                      OriginPolicy (HTTPS only, plus loopback)
Pi/Pairing/           PairingView (scan, paste, inline errors), ScannerView (VisionKit DataScanner)
Pi/Consent/           AIConsent (the stored OK, the gate), ConsentSheet (who receives your voice)
Pi/Resources/         Assets, PrivacyInfo.xcprivacy
Pi/Shell/             WebShell (WKWebView), ShellView (native loading/offline), NativeBridge (piNative handler)
Pi/Voice/             VoiceEngine (port of web/voice.js VoiceMode), VoiceCore (web/voice-core.js in JSContext), VoicePorts (seams),
                      RealtimeClient + Levels (WebRTC), AudioSessionController, BasicVoice, Earcons, LiveFleet, VoiceHost (voice.start)
Pi/VoiceUI/           VoiceScreen (orb, captions, question card, Mute/End), sheets, haptics
Pi/Dictation/         Dictation (dictation.* bridge calls), AudioRecorder (AAC .m4a)
Pi/Intents/           StartVoiceIntent, Mute/End Live Activity intents, AppShortcuts, VoiceActivityController
PiWidgets/            VoiceActivity (Live Activity + Dynamic Island), StartVoiceControl (Control Center / Action button)
PiNotifications/      Notification Service Extension: opens the sealed text of a push
Shared/               VoiceActivityAttributes (app + widgets)
scripts/              integration.sh, e2e.sh, release.sh (archive + upload to App Store Connect)
ExportOptions.plist   App Store Connect export (release.sh)
```

## Notes

- **Machines** live in the Keychain as `[{ id, machine, name, origin, d, k, primary, added, lastSeen }]` (account `machines`, service `pi-mobile`, accessible after first unlock, shared access group `$(AppIdentifierPrefix)$(PI_BUNDLE_PREFIX).shared` when entitled). A single older `device` entry is migrated. The page's `localStorage` copy is rewritten at every load (`BRIDGE.md`).
- **ATS: HTTPS only.** Info.plist has no ATS exceptions at all. The app accepts only `https://` computers: when pairing (scan or paste), for computers the web adds (`machines`), in `HubClient` (RPC, events, push registration) and in the web shell. The only exception is plain HTTP to loopback (`127.0.0.1`, `localhost`, `::1`), which ATS doesn't cover, so the simulator works against the `npm run ui` fixture (checked: e2e passes with no exceptions). A plain-HTTP link (LAN, Tailscale `100.x`, `.local`) gets "This computer needs its secure address" with the steps: install Tailscale, run `/remote`, and scan the new code (root README → *Lock-screen notifications and HTTPS*). A computer already paired over plain HTTP stays in the list. Its screen says to pair it again over HTTPS; it is never dropped silently. `OriginPolicy` holds the rule. In browsers the hub and web app behave as before.
- **Voice engine** (plan Step 5): every decision goes through `web/voice-core.js`, **only the copy the `Bundle voice-core.js` pre-build phase puts in the app** (App Review 2.5.2: no downloaded code; plan D3). A newer computer stays compatible through the hub's protocol and feature flags. `PiTests/Voice` drives the engine with `FakeRealtime` + `FakeHub` and that real file. Device-only checks are marked `[verify]` in the code.
- **Consent** (App Review 5.1.2(i)): before the first voice mode or dictation, `ConsentSheet` says who receives what (voice mode: OpenAI realtime via the computer's ChatGPT sign-in or API key, and the computer; dictation: the computer, which transcribes with its configured provider). Allow / Not now. The answer is stored as `AIConsent.version` in `UserDefaults` (`pi-ai-consent`); bump the version when the recipients change and everyone is asked again. The gate sits in `VoiceHost.start` (bridge, Siri / Action button, Answer by voice) and `Dictation.start`; a headless intent without consent continues in the app to ask. Revoke: voice settings → Stop sharing my voice, or the web menu (BRIDGE.md `consent.*`). `-PiReset` also clears it. Shots: `shots/consent/` (`TEST_RUNNER_CONSENT_SHOTS=<dir> … -only-testing:PiTests/ConsentShotsTests`).
- **Privacy:** `Pi/Resources/PrivacyInfo.xcprivacy` (required-reason APIs: UserDefaults CA92.1, `systemUptime` 35F9.1; audio and other user content collected for app functionality, not linked, no tracking). The extensions use no required-reason APIs. Policy: `PRIVACY.md` at the repo root, linked from the pairing screen, the consent sheet and voice settings. App Store steps: `APP_STORE.md`.

## Device checklist [device]

None of these have run on a real iPhone yet: everything above is checked in the simulator only. Fill in the Result column (date, iPhone model, iOS version) as you go.

| Check | Result |
|---|---|
| Scan the `/remote` code: the haptic fires and the web UI opens already paired. | not yet run on device |
| Deny the camera: the pairing screen offers Open Settings and pasting the link. | not yet run on device |
| Turn off the computer's hub: the app shows "Can't reach ‹name›" with Try again, never a WebKit error page. | not yet run on device |
| Light and dark: no white flash on launch or reload. | not yet run on device |
| The full web UI works: sessions, sending, answering a question, images. | not yet run on device |
| Voice mode answers a question with the screen locked (phone in a pocket). | not yet run on device |
| The undo-window and "stop" scenarios from `docs/voice.md` → Verification behave as on the web. | not yet run on device |
| A 30-minute voice session with the screen locked keeps going (events, status, the realtime call). | not yet run on device |
| Speakerphone barge-in: pi's own voice is not heard as you (Apple voice processing). | not yet run on device |
| Action button / Control Center "Talk to pi" starts voice, unlocked and locked. | not yet run on device |
| "Talk to pi in pi" (Siri) starts voice. | not yet run on device |
| The Live Activity shows the state and question; its Mute and End buttons work. | not yet run on device |
| AirPods stem press mutes and unmutes. | not yet run on device |
| AirPods out mid-session: audio moves to the speaker and voice keeps going. | not yet run on device |
| A phone call interrupts: voice resumes or offers "Tap to resume". | not yet run on device |
| Earcons are heard over the realtime audio; pi's voice ducks while you talk. | not yet run on device |
| Dictation over HTTPS pairing gives the distilled text; raw/undo chips work; music resumes after. | not yet run on device |
| `PI_PUSH=YES`, sandbox push: the lock screen shows the session and text (rewritten by `PiNotifications`); tapping opens that session; **Answer by voice** starts voice there. | not yet run on device (needs a paid team) |
| A Tailscale HTTPS (`https://….ts.net`) hub loads; a plain-HTTP link is refused with the secure-address hint; an old http computer asks to be re-paired. | unit tests; device not yet run |
| First voice mode and first dictation show the consent sheet; Not now starts nothing; Stop sharing my voice asks again. | simulator (e2e); device not yet run |

## Known gaps

- Nothing is verified on a real iPhone yet (checklist above). Code that depends on device behaviour is marked `[verify]`.
- Push needs a paid Apple developer team; a free team builds without it.
- Starting voice while locked may still need the app to open (plan §3); the intent then asks to continue in the app.
- AirPods mute without CallKit is unverified (plan §6).
- Voice mode uses the `voice-core.js` bundled in the app, which can lag a newer computer's web UI until the app is updated.
- The ChatGPT-sign-in realtime endpoint is undocumented and may change; voice then uses basic voice, which the app supports.
- The app is HTTPS only: a computer needs a secure address (Tailscale Serve via `/remote`, or your own HTTPS URL), even on the home Wi-Fi.
- No TestFlight or App Store build yet (`APP_STORE.md`, `scripts/release.sh`); no CarPlay UI (the Live Activity shows on CarPlay by itself); Android is a later plan.
