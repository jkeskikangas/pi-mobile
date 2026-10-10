# Multi-machine sessions — Implementation plan

**Design:** `designs/multi-machine.md` · **Spec:** `specs/multi-machine.md`

Each step ends green: `npx tsc --noEmit -p .` and `npm test` pass, and it is committed on its own. Steps 1–4 are invisible to users (INV-3 holds throughout); steps 5–6 expose the feature.

**Coordination:** `src/hub.ts`, `src/index.ts` and `web/app.js` are also being edited by the voice work. Keep edits to those files as small, anchored insertions, and commit only this feature's hunks (staged from `HEAD` plus a replacement script, as for the herdr commit).

## 1. Sealed channel framing (D4)

- `src/channel.ts`: optional `codec { encode(line: string): string; decode(line: string): string | undefined }`. A frame that fails to decode closes the channel.
- `src/crypto.ts`: `frameCodec(key, side)` with a per-direction 24-byte counter nonce (side byte + 64-bit counter). Decoding rejects any frame whose counter is not exactly the next one.
- Tests (`test/channel.test.ts`, new): round trip; tampered, reordered and replayed frames close the link; the local link without a codec is byte-identical to today.

## 2. Machine identity and roles (D3, INV-4)

- `src/store.ts`: `machine()` reads or creates `machine.json` `{ id, name }` (name defaults to the hub's current `machineName()`). Extend `Role` with `"machine"`. Add `Config.home?: { url: string; device: string; key: string }`.
- `src/hub.ts`: `createPairing("machine")`; `authenticate()` rejects role `machine` for `/api/rpc` and `/api/stream`; `hub` rpc returns `machines` (home's own entry plus peers).
- `src/protocol.ts`: `AgentInfo.machine?: { id: string; name: string }`; hub events `machine_up` and `machine_down`.
- Tests: a machine key gets 401 on rpc and stream; pairing with role `machine` works.

## 3. Home side: PeerAcceptor and AgentRegistry (UC-2/3/4/7, INV-2)

- `src/peer.ts`: `acceptPeer(hub, req, socket)` handles the sealed hello, the device role check and protocol check, and replaces an existing link for the same machine id.
- `src/hub.ts`: the `agents` map becomes an AgentRegistry (`{ via: "local" | peerId, info }`); the `upgrade` handler dispatches `pi-mobile-peer` to `acceptPeer` (allowed from any private address, not just loopback); `deviceCall("agent")` routes through it; revoking a machine closes its link.
- Peer messages in: `agents`, `ev`, `attention`, `presence`. Out: `req`/`res` for routed calls. Peer-originated `req` messages are refused (INV-2).
- Tests (`test/peer.test.ts`, new — two `Hub` instances on two ports in one process, with a fake spoke link):
  - a phone paired only with the home sees the spoke agent labelled with its machine;
  - send, answer and snapshot round-trip;
  - spoke attention reaches the home's `sendPush`; spoke presence suppresses it;
  - spoke drop → `machine_down` and `gone`; reconnect → `machine_up` and `reset`, within 10 s;
  - revoke → link closed and hello answered 403;
  - a spoke cannot call another machine's agent.

## 4. Spoke side: Upstream (UC-1/5, NFR-1/3, D7)

- `src/peer.ts`: `class Upstream`, started by `Hub.listen()` when `config.home` is set and stopped in `Hub.close()`. It mirrors local `publish()` output (local agents only), re-announces on reconnect, backs off ≤ 5 s, and stops on 403 with a visible state.
- `src/hub.ts`: when linked, `attention()` and presence forward to Upstream instead of pushing locally (D7).
- Tests: spoke hub failover (close the hosting hub, a second `HubLink` elects) re-links within 10 s; no local `sendPush` while linked.

## 5. Commands (UC-1/7)

- `src/index.ts`:
  - `/remote pair machine` on the home prints a link and code;
  - `/remote join <link>` on the spoke pairs, saves `config.home` and restarts the hub;
  - `/remote settings` gains "This machine's name" and "Linked to: <home> — unlink";
  - `/remote devices` shows machines;
  - the overview groups sessions by machine.
- Tests (`test/switch.test.ts`-style host, new file `test/machine-commands.test.ts`): join writes the config and links; unlink removes it; join is refused on a machine that is itself a home with peers (star only).

## 6. Phone (UC-2/3/6)

- `web/app.js`:
  - every session row and the header show a machine chip; the session sheet groups by machine, home first;
  - an offline machine is a greyed row "offline since …" (D6);
  - the attention pill names the machine ("box · api asks …");
  - the new-session sheet gets a machine picker (only machines with a `herdr` agent) and folders from that machine;
  - `machine_up`/`machine_down` update the list.
- `web/app.css`: chip and offline row styles.
- Tests: headless-Chrome E2E in `test/e2e/` (scratch script today) with two local "machines" (separate `PI_CODING_AGENT_DIR`s and ports, one joined to the other): one list with labels; kill the spoke → offline row; restart → back; answer a spoke dialog from the phone.

## 7. Voice across machines

Voice mode follows one session at a time and can switch between them mid-call; with several machines, that session may live on a machine without voice credentials, and the developer can't see which machine is which. Today `web/voice.js` sends every voice call to the focused session's machine.

- **Match sessions by machine too.** Move the `switch_session` scoring out of `web/voice.js` into `web/voice-core.js` as `matchSession(list, said)` (the native app shares that file, `plans/native-apps.md` D3). It also matches the machine name ("the api session on the box"). A name that fits sessions on two machines returns both and pi asks "On the laptop or the box?". `list` results carry `machine`. In `src/voice/realtime.ts`, the `switch_session` description says "on any of the developer's machines".
- **Say the machine only when it helps.** While more than one machine is online, announcements and the session list name it ("api on the box needs you"); with one machine, the copy stays as it is today (INV-3).
- **Speech runs where the credentials are.** `voiceSession`, `speak`, `voices`, `transcribe` and `distill` use the sign-in and voice config of the machine that serves them; a box signed in only to Anthropic has no realtime. `machines[]` in the `hub` rpc carries `voice: { realtime, speech, stt }` from each machine's VoiceHost. The phone chooses one speech machine when voice mode opens: the focused session's machine if it can, else a capable online one, home first. Switching sessions keeps the call. Session calls (`brief`, `details`, `voiceStatus`, `voiceState`, `send`, `answer`) always go to the session's own machine. `[DECISION NEEDED: OK to use another machine's sign-in for speech? Recommended yes: same person, same encrypted path.]`
- **A machine drops mid-call.** If it is the one serving the focused session: one earcon, then "The laptop went offline." The call stays up, and switching to other sessions still works. On `machine_up`: "The laptop is back", then the snapshot reloads. If it is the speech machine: basic voice on another capable machine, or the phone's own voice if none is left.
- **Voices** are the same set on every machine, since all machines run the same protocol version, so the phone's pick holds across switches.
- **Tests:**
  - `test/voice-core.test.ts`: `matchSession` (machine words, ambiguous names, one machine unchanged).
  - `test/peer.test.ts`: `voiceSession` for a spoke session is served by a capable home when the spoke reports no realtime, and `machine_down` rejects pending session calls with "<name> is offline".
  - `test/e2e/turns.mjs`: switch to a spoke session by voice.

## 8. Real-world check

Laptop ↔ Hetzner box over Tailscale:

- `join` from the laptop;
- close the lid → the phone shows the laptop offline; open it → its sessions are back within 10 s;
- a spawn on the box from the phone lands in the box's herdr;
- voice mode started on a box session switches to a laptop session and back without dropping the call; closing the laptop lid mid-call is announced once.

Update `README.md` ("Several machines") and the comparison table.

## Open decisions

- D7: a phone paired directly with the laptop gets no laptop pushes while the laptop is linked (design `[DECISION NEEDED]`).
- Spec \[ASSUMPTION\]: linked machines reach the home over Tailscale or a LAN, and the home needs no public address.
