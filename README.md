# pi-mobile

Continue your [pi](https://github.com/earendil-works/pi) sessions from your phone. Run `/remote`, scan the QR code, and the live session is in your pocket. When pi finishes or asks a question, your locked phone tells you; tap, answer, and pi carries on.

No server to install, no account, no third-party relay, no app store. Everything runs inside pi, and everything the phone and pi exchange is end-to-end encrypted.

## Five pieces that compose

| Piece | What it is |
|---|---|
| **Channel** | QR pairing gives each device its own key. Every request and event is sealed end to end (NaCl secretbox). Devices are `control` or `view`-only and can be revoked one at a time. |
| **Mirror** | A snapshot of the session plus a live event stream: streaming text, thinking, tool calls with live output, diffs. Reconnects replay exactly what was missed. |
| **Input** | Prompt, steer or queue while pi works, stop, slash commands, photos, model and thinking level, compact. |
| **Dialogs** | Any extension's `select` / `confirm` / `input` (permission gates included) appears on the phone. The terminal dialog stays open; the first answer wins and dismisses the other. |
| **Attention** | Lock-screen Web Push when pi finishes a long run, asks a question, or waits for terminal input. Payloads are encrypted to your browser, so the push service sees nothing. |
| **Voice** | Dictation that turns rambling speech into the prompt you meant (terminal and phone), and a hands-free voice mode for when you are driving, running or cooking. See [Voice](#voice). |

They multiply rather than add up:

- **Attention + Dialogs:** a permission gate fires, your locked phone buzzes "proj asks: Allow file change?", you tap it, the app opens on that session, you answer, and pi continues. You never touched the terminal.
- **Channel + every pi:** the hub serves every sharing pi on the machine, so one pairing, one URL and one notification setting cover all sessions. If the pi hosting the hub exits, another takes over within a second and the phone reconnects to the same URL.
- **Channel roles + Mirror:** a `view` device gets the full live mirror and can't act, which is useful for pairing or demos.

## Install

```bash
pi install npm:pi-mobile
```

From a checkout: `pi install /path/to/pi-mobile` (after `npm install`), or try it once with `pi -e ./src/index.ts --remote`.

## Use

**On your computer**, in any pi session:

```
/remote
```

That's the whole setup. It connects **this machine**: every pi session on it, running or started later, appears on your phone within a couple of seconds. The first time, it shows a QR code. Scan it, the panel closes by itself, and your phone is paired for good. After that, `/remote` shows which sessions are shared and where to open them.

```
/remote pair [view]   pair another device (view-only: watch, cannot act)
/remote off           stop sharing — this session only, or every session on the machine
/remote devices       paired devices; pick one to revoke
/remote settings      how phones reach this computer, HTTPS address, port
```

`pi --remote` shares a single session without turning on the machine switch.

**On your phone**, open the paired address (add it to the Home Screen):

- The session list is sorted by who needs you: asking a question, then working, then idle. Each row shows the session's task and latest reply.
- When a session you are *not* looking at asks something, a pill appears at the top: "⚠ api asks: Allow file change?". Tap it to jump there and answer.
- Only the session on screen streams its tokens and tool output to the phone. The others send status and questions, so ten busy agents cost little bandwidth or battery.
- Anything you send from the phone is echoed in the terminal as `📱 <device>: …`.

### Lock-screen notifications

Browsers allow Web Push only on HTTPS pages. Put an HTTPS address in front of the hub and tell pi about it:

```bash
tailscale serve --bg 7878                                  # private to your tailnet
# then in pi:
/remote settings   → HTTPS address → https://<machine>.<tailnet>.ts.net
```

Pair through that address. The app offers to turn notifications on; you can also find the option under **⋯**. On iPhone, add the page to the Home Screen first (iOS 16.4+). The "cloudflared" option in `/remote settings` also gives HTTPS, but its address changes whenever the hub restarts.

## Voice

Two different jobs. Design notes and research: [docs/voice.md](docs/voice.md).

### Voice input: speak instead of typing

In the terminal press **alt+m** (or `/voice`), talk, press **Enter** (or alt+m again). On the phone, **hold the mic** in the composer while you talk and let go (or tap once to start and tap ✓ when done).

What lands in the editor is not a transcript. It is the message you meant: self-corrections applied ("null, no wait, undefined" → `undefined`), fillers and restarts gone, several asks turned into a short list, and code names recovered from the repository ("get user by ID in off dot ts" → `getUserById` in `src/auth.ts`). Anything genuinely ambiguous is listed under *Unclear* instead of guessed. You review it and send.

```
/voice raw      the verbatim transcript instead      /voice undo     your text from before
/voice send     send right after distilling          /voice review   leave it in the editor (default)
/voice status   recogniser, model, microphone
```

- **Edit by voice, and it learns.** With text in the editor, "make that a list" or "drop the second point" edits it. Names you correct before sending are remembered for next time.
- **Recognition runs on your computer.** On macOS 26 it is Apple's on-device SpeechAnalyzer: free, private, live partial text while you talk, biased toward your project's names. A small Swift helper compiles on first use (needs Xcode command-line tools). Elsewhere, set `OPENAI_API_KEY` for `gpt-4o-transcribe`. The terminal records through `ffmpeg`.
- **Distillation** uses a fast model you already have in pi (it skips models your account can't use). The prompt carries your repo's file names, declared symbols and the last reply, so "that" and "the second option" resolve.

### Voice mode: a conversation when you can't look

Tap the **bars icon** in the phone's header. Talk; pi answers out loud. At home (cooking, tidying) the computer works too: open `http://127.0.0.1:7878` in its browser and use its microphone and speakers, no HTTPS needed. It is built for eyes and hands that are busy:

- **Talk about intent, not code.** The voice talks like an engineer on a walk: behaviour, design, decisions, risks, what is left. No identifiers, file names, commands or tool chatter. The full written answer stays in the transcript for later.
- **Sounds for state, words for news.** A tone when it hears you, a soft tick while pi works, a chime when it is done or needs you. It speaks when something changes what you do next: the outcome, a question, or a *significant* action that failed (production data, deploys, pushes, deletes).
- **Ask anything, any time.** "What's it doing?", "why did that fail?", "stop", "switch to the api session", "say that again", "what can I say?". Talk over pi and it quiets at once and stops if you keep going; an "mm-hmm" or a cough doesn't cut it off.
- **Answer pi's questions by voice, or with a tap.** Permission gates and other dialogs are read out, two options at a time, and shown as a card with big buttons. Irreversible actions need the action named: "yes, push", not "yeah". If you already asked for exactly that ("deploy the app to production") you are not asked again: it says "Deploying to production, say stop to cancel" and goes ahead after four seconds unless you say stop or tap Cancel.
- **pi knows you are listening.** While voice mode is on, the agent is told you can't read: outcome first, one clear question when it needs you, nothing to review on screen.
- **Headset friendly.** The play/pause button acts like tapping the circle; on AirPods the stem mutes the mic, and you hear a cue if you talk while muted.
- **Eyes-free / Can glance** sets how short it is. **Open mic / Tap to talk** picks how turns work (tap mode for wind, traffic, cycling). The circle fills the screen so it can be hit without looking.

Under the hood: a realtime speech model (`gpt-realtime-2`) talks with you directly from the phone over WebRTC, and pi on the computer opens the call with your ChatGPT sign-in (the endpoint Codex uses) or `OPENAI_API_KEY`. No token or audio passes through the computer. If realtime is unavailable it falls back to *basic voice*: voice detection on the phone, recognition on the computer, pi, and speech from the computer when one is configured (`voice.ttsUrl` pointing at any OpenAI-compatible `/v1`, such as [Voicebox](https://github.com/jamiepine/voicebox) or Kokoro running locally, or `gpt-4o-mini-tts` with `OPENAI_API_KEY`), otherwise the phone's own speech synthesis.

Limits: browsers give the microphone only to HTTPS pages, so voice on the phone needs the HTTPS address (see [Lock-screen notifications](#lock-screen-notifications)); `http://127.0.0.1` works on the computer itself. On iPhone the microphone stops when the screen locks, so voice mode keeps the screen awake (lower the brightness for a run); Android Chrome is more lenient while audio plays, but test it on your phone before relying on it in the car. Web apps can't use CarPlay; the phone's audio plays through the car as usual.

Settings live in `~/.pi/agent/pi-mobile/config.json` under `"voice"`: `stt` (`auto`/`apple`/`openai`), `locale` (e.g. `"fi-FI"`), `model` (`provider/id` for distillation and briefs), `realtime` (`auto`/`off`), `realtimeModel`, `realtimeVoice`, `turnDetection` (`semantic`/`server`), `ttsUrl`, `ttsModel`, `ttsVoice`, `ttsKey`, `tts` (`auto`/`off`), `afterDictation` (`review`/`send`). `PI_MOBILE_MIC` picks the terminal's microphone, or `file:<recording>` for demos.

## Security model

- **Pairing.** `/remote` creates a single-use key valid for 10 minutes and puts it in the QR URL's `#fragment`, which browsers never send to a server. The phone uses it to fetch its own long-lived device key.
- **Transport.** Requests carry a timestamp and nonce, and the hub rejects stale or replayed ones. No bearer tokens or cookies exist to steal from the wire. Plain LAN HTTP, Tailscale, a tunnel or a relay sees only ciphertext.
- **Local link.** pi processes join the hub over loopback, authenticated by `~/.pi/agent/pi-mobile/link.secret` (0600). Device keys live in `devices.json` (0600).
- **Push.** VAPID-signed. Payloads are encrypted to the subscribing browser (RFC 8291). Revoking a device drops its subscription.
- **Caveat.** On plain HTTP, the web app itself isn't integrity-protected. An *active* attacker on your LAN could serve a modified app that reads the device key. On untrusted networks, use the HTTPS address. A paired `control` device can do anything pi can, so revoke lost phones.

## How it works

```
 phone ──sealed HTTP + SSE──▶ hub (inside one pi) ◀──loopback link── other pi processes
```

- **Hub election:** binding the port is the lock. Others link to the holder; when it exits, one of them binds and takes over. The hub survives `/new`, `/resume` and `/reload` in its own process.
- **Exact merge:** events carry a hub sequence number (replay buffer for reconnects) and a per-process counter. Each snapshot reports that counter, so the phone merges it with in-flight events without gaps or duplicates.
- **Dialogs:** pi hands every extension the same `ctx.ui` object, so wrapping `select`, `confirm` and `input` covers all extensions. The losing side is dismissed through the dialog's abort signal. `editor` and custom TUI dialogs show on the phone as "waiting for input in the terminal".

## Compared with other pi remotes (October 2026)

| | this | [remote-pi](https://www.npmjs.com/package/@hk_net/remote-pi) | [@mipsel64/pi-remote-control](https://www.npmjs.com/package/@mipsel64/pi-remote-control) | [@pixu1980/pi-remote](https://www.npmjs.com/package/@pixu1980/pi-remote) | [pi-remote-control](https://www.npmjs.com/package/pi-remote-control) (Pi Relay) |
|---|---|---|---|---|---|
| Extra infrastructure | none | relay + native app | `prc` server binary + password | relay (third-party by default) + hosted PWA | daemon + iOS app + push gateway |
| Content visible to the relay/server operator | no (E2E) | yes, per its docs | runs on your machine | relay, unless self-hosted | not stated |
| Answer any extension's dialogs from the phone | **yes** | no | notifies only | pi-ask questions | not stated |
| Every pi on the machine, one pairing, failover | yes | yes (agent mesh) | yes (central server) | per-directory room | per session toggle |
| Lock-screen push | Web Push (HTTPS) | native app | Web Push (HTTPS) | Web Push | APNs via a gateway |
| View-only devices | **yes** | no | no | no | no |

The others have things this doesn't: native apps (remote-pi, Pi Relay), an agent-to-agent mesh across machines (remote-pi), and transcripts of sessions that have since closed (mipsel64).

## Development

```bash
npm install
npm test          # crypto, Web Push (RFC 8291 vector), hub/link integration, extension with a fake pi host
npm run typecheck
```

`test/phone.ts` is a test phone that speaks the same protocol as `web/app.js`.

## License

MIT
