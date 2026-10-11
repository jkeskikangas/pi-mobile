# Web ↔ native bridge (iOS app)

The contract between the web UI (`web/app.js`, `web/voice.js`, `web/fleet.js`) running in the app's `WKWebView` and the Swift shell. Plan: `plans/native-apps.md` Steps 3–4. The web side is active **only when `window.PiNative` exists**; in a browser nothing here runs.

## Trust

- Native handles a message **only if** `message.frameInfo.isMainFrame` is true **and** `message.frameInfo.securityOrigin` (scheme, host, port) equals the paired primary origin the web view loaded. Anything else: reply error `not allowed` and do nothing.
- The page is never trusted to delete credentials by itself. `unpaired` and removals in `machines` are **requests**: native deletes a Keychain entry only after confirming it (rules under each message). Additions are accepted as is (the page already holds those keys).

## Setup (native, before any page script)

A `WKUserScript` at `.atDocumentStart`, `forMainFrameOnly: true`. The Keychain is the source of truth for machines; the page's `localStorage` copy is overwritten on every load:

```js
localStorage["pi-mobile-machines"] = JSON.stringify(machines);           // authoritative list from the Keychain, may be [] only if the Keychain is empty
localStorage["pi-mobile-device"] = JSON.stringify({ d, k, role: "control", host }); // the primary entry's d, k, name
localStorage["pi-mobile-voice-persona"] = "…";                         // each voice pref the app holds (see prefs)
window.PiNative = { version: 1 };
```

Machine entry (`web/fleet.js`): `{ id, machine, name, origin, d, k, primary, added, lastSeen }`.
- `id`: this phone's own stable handle for the entry (string; the web generates it, native keeps it).
- `machine`: the computer's id from its hub (may be `""` until learned).
- `origin`: `""` for the primary (it is reached at the page's own origin, i.e. the origin native loads); full origin for the others.
- `primary`: exactly one entry is `true` — the computer that serves the web UI.
- `d`, `k`: device id and key (base64url, 32 bytes). `added`, `lastSeen`: ms timestamps (informational).

The web adds its functions to the same `window.PiNative` object when `web/voice.js` loads, so native must **not** replace `window.PiNative` after load.

## JS → native: `webkit.messageHandlers.piNative.postMessage(msg)`

Handler name `piNative`, registered with `WKScriptMessageHandlerWithReply` (`addScriptMessageHandler(_:contentWorld: .page, name: "piNative")`). `postMessage` returns a Promise: reply `(value, nil)` resolves it with `value`, reply `(nil, "text")` rejects it with an `Error` whose `message` is `text` (the web shows that text to the user, so write it as a sentence fragment, e.g. `Microphone access is off. Turn it on in Settings.`). Every `msg` is an object with a string `type`.

| `type` | Other fields | When | Reply |
|---|---|---|---|
| `voice.start` | `agent: string` (the session id as the hub reports it), `machine: string` (the `id` of the machines-list entry that hosts it) | Header voice button tapped and a session is open | `null` once the native voice screen is presented. Error text is shown as a toast. **Idempotent:** if voice mode is already open, native just focuses it (switching to `agent` if different). **Cancels dictation:** native stops and discards any dictation recording first (the web has already dropped its recording UI and will not send `dictation.cancel`). The web sends at most one `voice.start` at a time (waits for the reply). |
| `dictation.start` | — | Composer mic pressed (hold or tap) | `null` once recording has started. Error text is shown as `Microphone: <text>`. |
| `dictation.stop` | — | User finished (release, ✓, mic tap, 5-minute cap) | `{ audio: string, mime: string }`: `audio` is base64 (standard, no data-URL prefix) of the whole recording, `mime` e.g. `"audio/mp4"` (AAC in MP4/M4A, mono, 16–24 kHz is plenty). The web then calls `transcribe` itself. An empty/very short take (< 600 ms or < ~1.5 KB) is treated as "too short". Error text is shown as `Voice input failed: <text>`. |
| `dictation.cancel` | — | User cancelled (✕), also while a `dictation.stop` is still pending, or when a `dictation.start` resolved after the web had given the take up | `null`; stop if recording and discard the audio. **Must be idempotent** (no recording → still `null`). If a `dictation.stop` is pending, native may still reply to it; the web ignores that reply. Errors are ignored. |
| `prefs` | `key: string`, `value: string` | A voice preference changed in the web UI | `null` (ignored). Store in `UserDefaults`; write it back into `localStorage` at next document start. |
| `machines` | `machines: Entry[]` (the full list, shape above) | Every time the web saves its list: computer added (offer accepted, scan/paste), removed, renamed, re-paired, or learned its id | `null` (ignored). Native diffs against the Keychain by `id`: **new or changed entries are stored** (changed `d`/`k` = re-paired). **A missing entry is removed** only if that computer answers HTTP 401 to a sealed `hub` RPC with the stored `d`/`k`, or the user confirms a native alert ("Forget ‹name› on this iPhone?"); otherwise keep it (it is injected again next load). |
| `unpaired` | — | The user unpaired, revoked this device, removed the last computer, or every computer answered 401 | `null` (ignored). Same rule as removals: for each Keychain entry, delete it if its computer answers 401 (the web revokes before unpairing) or the user confirms a native alert; then, if nothing is left, show the pairing screen. Not sent on the silent startup path where the page simply finds no device. A `machines` message with `[]` usually precedes it. |
| `push.status` | — | Once at page start | `{ on: boolean, permission: "granted" \| "denied" \| "default" }`: `on` = the user turned notifications on in the app, iOS allows them, and APNs gave a token. |
| `push.enable` | `on: boolean` | The Notifications row in the menu ("Turn on/off notifications") | The new `push.status` value. `on: true` asks iOS for permission (only here, never at first launch), gets the APNs token and sends `push { apns: { token, sandbox } }` to **every** paired computer (again whenever the token changes or a computer is added); `on: false` sends `push { apns: null }` to each. Errors: `Notifications are off for pi. Turn them on in Settings.`, or the build has no push entitlement (README → Push). |

`prefs` keys (all strings):

| Key | Values |
|---|---|
| `pi-mobile-voice-persona` | persona id (`marin`, `cedar`, `coral`, `ash`, or what `voices` returns) |
| `pi-mobile-voice-attention` | `eyes-busy` \| `glance` |
| `pi-mobile-voice-turns` | `open` \| `tap` (push to talk) |
| `pi-mobile-voice-uses` | integer as string (hint fading) |
| `pi-mobile-voice-intro` | `"1"` once the first-time intro was spoken |

In practice only `persona` is changed in the web inside the app (the voice picker in the menu); the other keys are written by the web voice mode, which the app replaces, so native voice mode updates its own copy and re-injects it at next document start.

### Dictation ordering (what the web guarantees)

- At most one take at a time: no `dictation.start` while a start is pending, a take is recording, or a `dictation.stop` is pending.
- `dictation.stop` is sent only after the matching `dictation.start` resolved. If the user lets go (or taps ✕) before it resolves, the web sends `dictation.stop` (or `dictation.cancel`) right after it resolves.
- If `dictationEnded()` arrives while a start is pending, the web sends `dictation.cancel` when that start resolves.

## Native → JS: functions on `window.PiNative`

Call with `webView.evaluateJavaScript("window.PiNative.<fn>(…)")` on the main thread. Guard with `window.PiNative?.<fn>?.(…)` in case the page is still loading. All return `undefined`.

| Function | Argument | When | Effect |
|---|---|---|---|
| `level(x)` | `number` 0–1, linear RMS amplitude (e.g. `pow(10, averagePower/20)` from `AVAudioRecorder`, metering on) | While dictating, ~20–60 times a second | Drives the recorder strip's waveform (the last value is sampled every animation frame). |
| `dictationEnded(message?)` | optional `string` | Recording stopped on the native side without the web asking (interruption, route loss, error) | Drops the take and the recording UI (also a pending start); shows `message` as an error if given. Native discards the audio. |
| `focus(machine, agent)` | `string` hub machine id (may be `""`), `string` session id | The user tapped a notification (or "Answer by voice" on one); sent once the page has loaded | Closes any sheet and opens that session (`openAgent`). |
| `voiceClosed()` | — | The native voice screen was dismissed and the web view is visible again | Reloads the focused session (`loadCurrent()`) so the transcript catches up. |

## What the web changes when `window.PiNative` exists

- Header voice button → `voice.start` instead of the web voice screen; no HTTPS check; any dictation in progress is dropped first.
- Composer dictation records natively (above); transcription, raw/undo chips and `learn` are unchanged.
- The menu's Notifications row uses `push.status` / `push.enable` instead of Web Push (none in `WKWebView`); with no computer reporting `apns` in its `hub` result, a note points to `/remote settings`.
- Voice preference writes also post `prefs`; machine-list saves post `machines`.
- Unpairing posts `unpaired`.

Version: `window.PiNative.version` is set by native (currently `1`); bump it if this contract changes incompatibly, and gate new web behaviour on it.
