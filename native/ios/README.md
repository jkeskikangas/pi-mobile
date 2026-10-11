# pi for iOS

The native iOS app: the web UI in a `WKWebView`, plus what the web can't do (QR pairing now; voice mode, dictation audio, Live Activity later). Plan: `plans/native-apps.md`. Web ↔ native contract: `BRIDGE.md`.

## Build and test

```sh
cd native/ios
xcodegen                      # writes Pi.xcodeproj (not committed)
xcodebuild test -scheme Pi -destination 'platform=iOS Simulator,name=iPhone 16'
./scripts/integration.sh      # PiIntegrationTests against the `npm run ui` fixture hub
```

Xcode 26.6 needs the iOS 26.5 platform for any simulator build (`xcodebuild -downloadPlatform iOS`). `name=iPhone 16` resolves to the newest OS, so create an iPhone 16 on 26.5 if only older runtimes have one: `xcrun simctl create "iPhone 16" com.apple.CoreSimulator.SimDeviceType.iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-26-5`.

Bundle ids come from the `PI_BUNDLE_PREFIX` build setting (default `dev.pimobile`): set it and `DEVELOPMENT_TEAM` to run on your own device.

### Integration test

`scripts/integration.sh` starts `test/ui/fixture.ts` on port 7989, passes its `127.0.0.1` pairing link to the test as `TEST_RUNNER_PI_PAIR_LINK`, and types `ask` into the fixture every 4 s. The test pairs through `HubClient`, calls `hub`, opens the event stream, sees `hello` and `info`, answers the confirm prompt and waits for its `prompt_end`. Without a link the test is skipped, so the plain `xcodebuild test` stays green offline.

### Screenshots

Debug builds accept launch arguments for the simulator, which has no camera: `-PiReset` forgets every computer, `-PiPairLink <link>` pairs at launch, `-PiAssumeScanner` shows the scan button. Current shots: `shots/`.

## Packages (exact versions)

| Package | Version | Why |
|---|---|---|
| [jedisct1/swift-sodium](https://github.com/jedisct1/swift-sodium) | 0.11.0 | secretbox (XSalsa20-Poly1305), wire-compatible with tweetnacl-js (plan D6) |
| [stasel/WebRTC](https://github.com/stasel/WebRTC) | not added yet; pin 154.0.0 (latest tag on 2026-10-11) in the voice step | realtime voice (plan D4). Left out until Step 5 to keep builds fast. |

## Layout

```
project.yml           XcodeGen spec: Pi, PiWidgets (placeholder), PiTests, PiIntegrationTests
Pi/App/               PiApp, AppModel (machines, prefs, one HubClient per machine), Info.plist, entitlements
Pi/Core/              JSON, Envelope (sodium), HubClient (pair, rpc, agent, SSE events), SSEParser, Models, Keychain (+ MachineStore)
Pi/Pairing/           PairingView (scan, paste, inline errors), ScannerView (VisionKit DataScanner)
Pi/Shell/             WebShell (WKWebView), ShellView (native loading/offline), NativeBridge (piNative handler)
PiWidgets/            placeholder widget bundle (Live Activity and Control arrive in Step 7)
Shared/               VoiceActivityAttributes (app + widgets)
scripts/integration.sh
```

## Notes

- **Machines** live in the Keychain as `[{ id, machine, name, origin, d, k, primary, added, lastSeen }]` (account `machines`, service `pi-mobile`, accessible after first unlock, shared access group `$(AppIdentifierPrefix)$(PI_BUNDLE_PREFIX).shared` when entitled). A single older `device` entry is migrated. The page's `localStorage` copy is rewritten at every load (`BRIDGE.md`).
- **ATS:** `NSAllowsArbitraryLoads` stays on with `NSAllowsLocalNetworking`: hubs are reached on plain HTTP over the LAN or Tailscale (`100.x`), and every payload is end-to-end encrypted. [verify] on a device whether `NSAllowsLocalNetworking` alone covers Tailscale addresses; if it does, drop `NSAllowsArbitraryLoads`.
- **Voice and dictation** messages from the page answer "not in this version yet" until Steps 5 and 8.

## Device checklist [device]

- Scan the `/remote` code; the haptic fires and the web UI opens already paired.
- Deny the camera: the pairing screen offers Open Settings and pasting the link.
- Turn off the computer's hub: the app shows "Can't reach ‹name›" with Try again, never a WebKit error page.
- Light and dark: no white flash on launch or reload.
