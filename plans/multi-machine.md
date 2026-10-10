# Multi-machine sessions — Implementation plan

**Spec:** `specs/multi-machine.md` (v2) · **Design:** `designs/multi-machine.md` (v2). This replaces the v1 "home hub" plan, which was never started.

Each step ends green: `npm test`, `npm run typecheck`, and for UI steps `npm run shots`, then it is committed on its own. Until step 5, the work is invisible to a single-machine user (INV-3).

**Coordination:** other agents edit `src/hub.ts`, `src/index.ts`, `web/app.js` and `web/app.css`. Keep edits there small and anchored, and commit only your own hunks.

## What the owner will do (the bar every step serves)

1. **Once:** run `/remote` on the laptop and scan the QR code, exactly as today.
2. **Per new box:** ask pi to create it, or run `/remote add box` yourself. The phone shows "Add box?"; tap Add, and box's sessions are in the list. pi can run `pi-mobile add <ssh-host>` as part of provisioning.
3. **Deleting a box:** pi runs `/remote remove box` (or you remove it on the phone), and it leaves the list.
4. **Every day:** one list. "laptop · offline since 14:02" while the lid is closed; everything else, notifications included, keeps working.

Each machine after the first needs Tailscale with HTTPS (`tailscale serve`), and so does the phone. That is a one-time tailnet setting; `add` checks it and prints the exact fix.

## 1. Machine identity, CORS and CSP (invisible)

- `src/store.ts`: `machine()` reads or creates `machine.json` `{ id, name }`; the name defaults to the short hostname.
- `src/hub.ts`:
  - `hub` rpc adds `machine` and `protocol`;
  - `/api/*` answers CORS with `Access-Control-Allow-Origin: *` and no credentials (bodies are sealed);
  - the page CSP's `connect-src` becomes `'self' https://*.ts.net`, plus HTTPS addresses from config;
  - push payloads gain `machine`.
- `web/sw.js`: notification tag `pi-<machine>-<agent>`; a click opens `?machine=…&agent=…`.
- `test/ui/fixture.ts`: optional `--machine <name>` so two fixtures can run on two ports.
- Tests (`test/hub.test.ts`): CORS preflight and response headers; `hub` returns `machine`; payload shape.

## 2. The phone's Fleet, one machine first (invisible)

- `web/fleet.js` (new, no DOM; loaded by the page and by `node --test`):
  - the machine list in `localStorage` `pi-mobile-machines`;
  - one sealed RPC and SSE connection per machine;
  - per-machine online/offline state with 0.5–5 s backoff and the existing 40 s stall rule;
  - the merged session map keyed `machine/agent`, plus `call(key, m, p)` routing;
  - migration of `pi-mobile-device` into a one-entry list whose origin is `location.origin`.
- `web/app.js`: `S.device` and `S.agents` come from the Fleet; `api/rpc` and `api/stream` become absolute URLs per machine. No visible change.
- `web/sw.js`: cache the app shell (cache-first, refreshed in the background); `/api` always goes to the network.
- Tests:
  - `test/fleet.test.ts` (new): migration; routing; a stopped machine goes offline without touching the others; reconnect within 10 s; keys never mixed between machines.
  - `npm run shots` unchanged.

## 3. Several machines on the phone (visible, added by hand)

- **UI** (`web/app.js`, `web/app.css`, per `docs/ui.md`):
  - the session list stays grouped Needs you → Working → Idle; each row and the header gain a machine chip, but only when there are two or more machines;
  - an offline machine is one quiet row, "laptop · offline since 14:02";
  - the attention bar names the machine ("box · api asks …");
  - new menu section "Computers": each machine with its state; Remove; Add a computer.
- **Add a computer, the UC-3 fallback:** Paste link, plus Scan where `BarcodeDetector` exists, else a vendored QR decoder in `web/` (no CDN; check its licence).
  - Pairing runs against that machine's origin, then `fleet.add`.
  - Removing calls `revoke` on that machine if it is reachable, then forgets it.
- **Notifications:** the phone sends `push` (subscription plus the fleet VAPID key) to every machine. A machine adopts the key only if it has none, or on an explicit rotation.
- **Tests:**
  - shots with two fixtures (one list with chips; an offline row; the Computers sheet; the offer sheet from step 4);
  - a browser E2E: stop the origin fixture, reload, and the shell loads from cache with the other machine's sessions;
  - `test/webpush.test.ts`: two hubs with one VAPID key sign valid authorizations for one subscription.

## 4. Add from a trusted machine (the Apple-like path)

- **`src/cli.ts` + `src/enrol.ts`** (new; `bin: { "pi-mobile": "src/cli.ts" }`, run with `--experimental-strip-types` like the tests):
  - `pi-mobile enrol` reads JSON on stdin: `{ phones: [{ name, sub? }], vapid, from }`;
  - it creates `machine.json` and one device per phone (fresh keys), adopts VAPID and subscriptions, and finds the HTTPS origin from `tailscale status --json`, running `tailscale serve --bg <port>` if needed;
  - it prints `{ machine, origin, devices: [{ phone, d, k }] }`;
  - it works before any pi runs; it never prints keys except in that JSON, and never takes them in argv.
- **`src/sponsor.ts` + `src/index.ts`:**
  - `/remote add <ssh-host>` and headless `pi-mobile add <ssh-host>`: run `ssh <host> npx -y pi-mobile@<this version> enrol` with stdin;
  - check that the origin is on this tailnet's `ts.net` (otherwise ask for `--allow-origin`);
  - store one offer per phone in `offers.json` (7-day TTL) and push "Add <name>?";
  - print where it stands ("Waiting for your phone to approve").
- **Offers:** `src/hub.ts` delivers pending offers on the phone's stream (`machine_offer`) and drops them once acknowledged.
- **Phone:** the offer sheet, "Add box? Added from laptop · box.tailnet.ts.net", with Add (primary) and Not now.
  - Not now revokes the phone's device on box.
  - An offer is never added without Add.
- **Tests:**
  - `test/enrol.test.ts`: a temp `PI_CODING_AGENT_DIR`; devices are per phone; keys differ per machine; no secrets in argv; refuses to replace a different VAPID key without `--force`.
  - `test/sponsor.test.ts`: a fake `ssh` on `PATH`, offers persisted and delivered once.
  - shots: the offer sheet in both themes.

## 5. Remove and rotate

- `/remote remove <name>` and `pi-mobile remove <name>` queue `machine_removed` to every phone and revoke the phone devices on that machine if reachable.
- The phone forgets the machine. On next open it rotates the VAPID key: WebCrypto P-256 keypair, re-subscribe, then `push` the new subscription and key to each remaining machine.
- After 7 days offline, the Computers sheet offers Remove for a machine, never automatically.
- Tests: rotation in `fleet.test.ts` with a fake `PushManager`; a removed machine's device gets 401.

## 6. herdr: start a session on a chosen machine

The new-session sheet gains a machine picker, listing only machines with a herdr agent, and shows folders from that machine. The spawn goes to that machine.

## 7. Voice across machines

Voice mode follows one session at a time and can switch mid-call; that session may live on a machine without voice credentials.

- **Match sessions by machine too.**
  - Move the `switch_session` scoring from `web/voice.js` into `web/voice-core.js` as `matchSession(list, said)`; the native app shares that file (`plans/native-apps.md` D3).
  - It matches machine names ("the api session on the box"). A name that fits two machines returns both, and pi asks "On the laptop or the box?".
  - In `src/voice/realtime.ts`, the tool description says "on any of the developer's machines".
- **Say the machine only when it helps:** only while more than one machine is known ("api on the box needs you").
- **Speech runs where the credentials are.**
  - Each machine's `hub` rpc reports `voice: { realtime, speech, stt }`.
  - When voice mode opens, the phone picks one speech machine: the focused session's machine if it can, else any capable online one. It uses that machine for `voiceSession`, `speak`, `voices`, `transcribe` and `distill`, and keeps it across session switches.
  - Session calls (`brief`, `details`, `voiceStatus`, `voiceState`, `send`, `answer`) go to the session's own machine.
  - Using another machine's sign-in is decided: yes (2026-10-10).
- **A machine drops mid-call.**
  - If it is the session's machine: one earcon, then "The laptop went offline." The call stays up. When it returns: "The laptop is back."
  - If it is the speech machine: switch to another capable machine, or basic voice with the phone's own voice.
- **Tests:**
  - `test/voice-core.test.ts`: `matchSession`.
  - Fleet tests: the speech machine is chosen by capability.
  - `test/e2e/turns.mjs`: switch to a session on the second fixture by voice.

## 8. Real-world check and docs

On the laptop and two Hetzner boxes over Tailscale:
- `add` from the laptop for each box, approve on the phone;
- close the lid: the boxes keep working and notifying, and the laptop shows offline;
- delete a box with `remove`;
- voice-switch from a box session to a laptop session and back;
- the app opens from the Home Screen while the laptop sleeps.

Then update:
- `README.md`: a "Several machines" section with the four owner steps above, and a note on machine names in certificate logs;
- the comparison table;
- `docs/ui.md` with the new components;
- `plans/native-apps.md` if anything changed.

## Status (2026-10-10, branch `multi-machine`)

- **Done:** steps 1–5 and 7, plus step 6's computer picker. The command is `bin/pi-mobile.mjs`: plain JavaScript, because Node won't strip TypeScript types inside `node_modules`, so `npx` runs it on a fresh box.
- **Covered by tests:**
  - `test/machines.test.ts`: enrol/add/remove, offers, CORS, CSP and the push key;
  - `test/fleet.test.ts`: real hubs; one list, routing, offline and back, revoked, duplicates;
  - `matchSession`;
  - `npm run shots -- --only machines`, in both themes at 390 and 320 px.
- **Not built:** Scan in Add a computer (paste only for now; iOS has no `BarcodeDetector`).
- **Not verified:**
  - `/remote add` over real ssh, and `tailscale serve` on a real box;
  - the iOS offline launch;
  - Chrome Local Network Access.

`npx pi-mobile@<version> enrol` only works once a version with `bin/` is published. Until then, set `PI_MOBILE_ENROL` to a command that runs this checkout's `bin/pi-mobile.mjs enrol` on the box.

## Open

- `[verify on device]` iOS offline launch of the cached shell after a week unused (D5).
- `[verify]` Chrome Local Network Access with `*.ts.net` origins on Android.
- `[ASSUMPTION]` Machines after the first are reached over Tailscale HTTPS. If the owner wants a LAN-only second machine, it needs its own HTTPS address.
