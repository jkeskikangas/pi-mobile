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

They multiply rather than add up:

- **Attention + Dialogs:** a permission gate fires, your locked phone buzzes "proj asks: Allow file change?", you tap it, the app opens on that session, you answer, and pi continues. You never touched the terminal.
- **Channel + every pi:** the hub serves every sharing pi on the machine, so one pairing, one URL and one notification setting cover all sessions. If the pi hosting the hub exits, another takes over within a second and the phone reconnects to the same URL.
- **Channel roles + Mirror:** a `view` device gets the full live mirror and can't act, which is useful for pairing or demos.

## Install

```bash
pi install /path/to/pi-mobile     # from a checkout (after npm install)
```

Or try it once: `pi -e ./src/index.ts --remote`.

## Use

```
/remote                  share this session and show a pairing QR code
/remote view             QR code for a view-only device
/remote stop             stop sharing this session
/remote status           hub, addresses, connected phones, shared sessions
/remote devices          paired devices;  /remote revoke <id|name|all>
/remote auto on|off      share every pi session automatically
/remote expose network|local|cloudflared
/remote url <https://…|off>   HTTPS address in front of the hub (see below)
/remote port <n>         default 7878
/remote restart          restart the hub to apply port/exposure/url changes
```

`pi --remote` shares from startup. The footer shows `📱 remote on` / `📱 1 connected`. Anything sent from the phone is echoed in the terminal as `📱 <device>: …`.

### Lock-screen notifications

Browsers allow Web Push only on HTTPS pages. Put an HTTPS address in front of the hub and tell pi about it:

```bash
tailscale serve --bg 7878                                  # private to your tailnet
# then in pi:
/remote url https://<machine>.<tailnet>.ts.net
/remote restart
```

Pair through that address, then choose **⋯ → Notify me when pi finishes or asks**. On iPhone, add the page to the Home Screen first (iOS 16.4+). `/remote expose cloudflared` also gives HTTPS, but its address changes whenever the hub restarts.

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
