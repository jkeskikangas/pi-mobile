# Web ↔ native bridge (iOS app)

The contract between the web UI (`web/app.js`, `web/voice.js`) running in the app's `WKWebView` and the Swift shell. Plan: `plans/native-apps.md` Steps 3–4. The web side is active **only when `window.PiNative` exists**; in a browser nothing here runs.

## Setup (native, before any page script)

A `WKUserScript` at `.atDocumentStart`, main frame only:

```js
localStorage["pi-mobile-device"] = JSON.stringify({ d, k, role, host }); // from the Keychain
localStorage["pi-mobile-voice-persona"] = "…";                          // each voice pref the app holds (see prefs)
window.PiNative = { version: 1 };
```

The web adds its functions to this same object (below) when `web/voice.js` loads, so native must **not** replace `window.PiNative` after load.

## JS → native: `webkit.messageHandlers.piNative.postMessage(msg)`

Handler name `piNative`, registered with `WKScriptMessageHandlerWithReply` (`addScriptMessageHandler(_:contentWorld: .page, name: "piNative")`). `postMessage` returns a Promise: reply `(value, nil)` resolves it with `value`, reply `(nil, "text")` rejects it with an `Error` whose `message` is `text` (the web shows that text to the user, so write it as a sentence fragment, e.g. `Microphone access is off. Turn it on in Settings.`). Every `msg` is an object with a string `type`.

| `type` | Other fields | When | Reply |
|---|---|---|---|
| `voice.start` | `agent: string` (the focused session id, `machine/agent` form when several machines) | Header voice button tapped and a session is open | `null` once the native voice screen is presented. Error text is shown as a toast. |
| `dictation.start` | — | Composer mic pressed (hold or tap) | `null` once recording has started. Error text is shown as `Microphone: <text>` and no recording UI appears. |
| `dictation.stop` | — | User finished (release, ✓, mic tap, 5-minute cap) | `{ audio: string, mime: string }`: `audio` is base64 (standard, no data-URL prefix) of the whole recording, `mime` e.g. `"audio/mp4"` (AAC in MP4/M4A, mono, 16–24 kHz is plenty). The web then calls `transcribe` itself. An empty/very short take (< 600 ms or < ~1.5 KB) is treated as "too short". Error text is shown as `Voice input failed: <text>`. |
| `dictation.cancel` | — | User cancelled (✕) | `null`; discard the audio. Errors are ignored. |
| `prefs` | `key: string`, `value: string` | A voice preference changed in the web UI | `null` (ignored). Store in `UserDefaults`; write it back into `localStorage` at next document start. |
| `unpaired` | — | The user unpaired, revoked this device, removed the last computer, or every computer answered 401 | `null` (ignored). Clear the Keychain device(s); the page already cleared its `localStorage` and shows "Connect to pi". Native should then show its pairing screen. Not sent on the silent startup path where the page simply finds no device. |

`prefs` keys (all strings):

| Key | Values |
|---|---|
| `pi-mobile-voice-persona` | persona id (`marin`, `cedar`, `coral`, `ash`, or what `voices` returns) |
| `pi-mobile-voice-attention` | `eyes-busy` \| `glance` |
| `pi-mobile-voice-turns` | `open` \| `tap` (push to talk) |
| `pi-mobile-voice-uses` | integer as string (hint fading) |
| `pi-mobile-voice-intro` | `"1"` once the first-time intro was spoken |

In practice only `persona` is changed in the web inside the app (the voice picker in the menu); the other keys are written by the web voice mode, which the app replaces, so native voice mode should update its own copy and re-inject it at next document start.

Ordering: the web never sends `dictation.stop`/`cancel` without a resolved `dictation.start`, and never sends a second `dictation.start` while one is recording or the start is pending.

## Native → JS: functions on `window.PiNative`

Call with `webView.evaluateJavaScript("window.PiNative.<fn>(…)")` on the main thread. Guard with `window.PiNative?.<fn>?.(…)` in case the page is still loading. All return `undefined`.

| Function | Argument | When | Effect |
|---|---|---|---|
| `level(x)` | `number` 0–1, linear RMS amplitude (e.g. `pow(10, averagePower/20)` from `AVAudioRecorder`, metering on) | While dictating, ~20–60 times a second | Drives the recorder strip's waveform (the last value is sampled every animation frame). |
| `dictationEnded(message?)` | optional `string` | Recording stopped on the native side without the web asking (interruption, route loss, error) | Drops the take and the recording UI; shows `message` as an error if given. Native discards the audio; the web will not send `dictation.stop`. |
| `voiceClosed()` | — | The native voice screen was dismissed and the web view is visible again | Reloads the focused session (`loadCurrent()`) so the transcript catches up. |

## What the web changes when `window.PiNative` exists

- Header voice button → `voice.start` instead of the web voice screen; no HTTPS check.
- Composer dictation records natively (above); transcription, raw/undo chips and `learn` are unchanged.
- The menu has no Notifications section (no Web Push in `WKWebView`) until push lands (plan Step 9).
- Voice preference writes also post `prefs`.
- Unpairing posts `unpaired`.

Version: `window.PiNative.version` is set by native (currently `1`); bump it if this contract changes incompatibly, and gate new web behaviour on it.
