# Notifications without a developer-operated server

**Date:** 2026-10-11. **Status:** proposal; CloudKit feasibility spike required before promising native background alerts. **Scope:** App Store iPhone app, user-owned macOS/Linux Node hubs. No code changes in this document.

## Decision / problem

Keep the existing Safari Home Screen PWA Web Push as the shipping, relay-free notification option. Prototype **CloudKit private-database alert subscriptions** as the only credible native-app candidate found that needs neither our APNs signing key on users’ computers nor our server. Ship that transport only after the authentication longevity and physical-device gates below pass. Keep direct APNs with the **user’s own team key** for self-builds.

**There is no demonstrated solution here that guarantees seconds-latency native alerts for every user, including iCloud-signed-out users.** If “seconds, always, native-only, no iCloud” is absolute, the constraints cannot currently all be met. Do not disguise polling or an expiring CloudKit token as that solution. Web Push and APNs themselves are best effort, not delivery SLAs.

CloudKit adds a cloud mailbox operated by Apple, not by us. It is compatible with “no developer relay,” but not with “no cloud intermediary whatsoever.” Tailscale remains the data/control path; Apple services carry only ciphertext plus unavoidable routing/traffic metadata.

### Constraints and non-goals

| Requirement | Design rule |
|---|---|
| No developer-operated relay/server | Native app and hubs talk directly to Apple CloudKit/APNs or browser push endpoints. No token broker, gateway, public callback service, analytics backend, or hosted credentials. |
| Never distribute developer `.p8` | No developer APNs key or CloudKit server-to-server private key in app, extension, npm package, configuration, or documentation examples. A container API token is a different, client-facing credential, not a signing key. |
| Apple/intermediaries must not see names/questions/content | `src/crypto.ts` seals all application content before upload. Only generic fallback alert text and random identifiers may be plaintext. No names in record IDs, predicates, URLs, logs, or push topics. |
| User computers, macOS/Linux, Node, Tailscale | Standard HTTPS Web Services from any hub OS; encrypted pairing/RPC over Tailscale. No requirement for a Mac CloudKit helper. |
| Timely “pi needs you” | Visible alert subscription, not silent notification followed by polling. Target measured seconds in healthy conditions; explicitly expose degraded states. |
| App Store compliant | Public APIs, optional notification permission, real background modes only. Actual approval remains **[verify]**. |

Privacy means **remote services cannot read content**. It does not mean the local iPhone OS cannot render decrypted notifications. Apple can still observe iCloud account, container, IP addresses, timing, record sizes, random destinations, and notification traffic. Padding reduces size leakage, not timing leakage. A compromised paired computer already has session/control access.

## Current repository baseline

Read: `AGENTS.md`, `README.md`, `plans/native-apps.md` §11, `docs/native-research.md` §4 and §7, `src/apns.ts`, `src/webpush.ts`, `src/crypto.ts`, `src/hub.ts` attention path, `src/store.ts`, `native/ios/Pi/App/PushCenter.swift`, `native/ios/Pi/Core/PushContent.swift`, and `native/ios/PiNotifications/`.

- `Hub.attention()` suppresses alerts while the user is at a terminal, then sends Web Push and optionally APNs. APNs carries a generic alert plus `seal(deviceKey, {title, body, agent, machine})`.
- `src/apns.ts` uses HTTP/2, an ES256 provider JWT signed by a configured `.p8`, a visible mutable alert, and optional time-sensitive interruption level. This works for own-team builds; a user’s team cannot send to our App Store app topic.
- `PushCenter` requests permission on explicit enable, registers the native token on every launch, and reconciles each paired hub. `PushContent` tries paired keys, decrypts, groups locally, and supplies session/voice navigation. The current NSE rewrites synchronously and expects a top-level `sealed` value.
- `src/webpush.ts` already implements RFC 8291 payload encryption and RFC 8292 VAPID using hub-owned keys. No APNs developer membership/key is needed for Web Push.
- The optional relay suggested in `docs/native-research.md` §7 is **not** permitted for this distribution. Local Live Activity updates during an actual running voice session remain useful but are not general background notification delivery.

## Options and verdicts

Sources are linked by ID in the source ledger. **[verify]** means current documentation does not establish the required behavior, or an account/device/App Review experiment is necessary.

| Option | Findings / verdict | Sources |
|---|---|---|
| CloudKit private DB + user web auth | HTTP access on behalf of the user is documented; native token fetch example uses the private DB. A Node/Linux caller can use HTTPS, with no APNs signer. **Best native candidate, conditional, not yet proven unattended.** Single-use token rotation, idle expiry, NSE fetch and coalescing are release blockers. | [C1], [C2], [C3], [C4] |
| `CKQuerySubscription` + mutable visible alert | Can select the random destination and include generic alert text. Set `shouldSendMutableContent`; NSE fetches ciphertext from the triggering record. **Preferred CloudKit alert mechanism.** Do not inline full ciphertext in `desiredKeys`: strings over 100 characters may be truncated. | [C3], [C5], [C6] |
| `CKDatabaseSubscription` | Private/shared DB only; watches custom zones, not the private default zone. Good sync/change hint, **not preferred per-event alert routing**; no triggering-record fields equivalent to a query notification. Use only for optional catch-up, not seconds-latency delivery. | [C4] |
| Local Push Connectivity (`NEAppPushProvider`) | Persistent extension allowed on configured Wi-Fi SSIDs, 1–10 exact SSIDs; special requested `app-push-provider` entitlement in app and extension. **Reject as universal transport**: no ordinary cellular/VPN/all-network activation. A restricted-network opt-in feature is separate scope. | [N1], [N2], [N3] |
| Live Activity push-to-start / broadcast | Updates/starts still arrive through authenticated APNs. Broadcast reduces per-device fan-out, does not remove provider credentials; channels are not a way for arbitrary user hubs to avoid our key. **Reject as credential escape hatch.** Local voice activity updates stay. | [L1], [L2], [A1] |
| `BGAppRefreshTask` + local notification | System chooses execution time; earliest-begin is not a timer/deadline. Execution opportunity may be absent. **Reject for seconds latency**; optional eventual catch-up only. | [B1], [B2] |
| Safari Home Screen PWA Web Push | iOS 16.4+, HTTPS, user gesture to subscribe. Hub VAPID key and encrypted standard Web Push, no developer signing secret. **Keep and recommend as complement/fallback.** Separate PWA identity/permission; not native WKWebView push. | [W1], [W2] |
| Declarative Web Push | iOS 18.4+: browser displays fallback even if worker fails/is removed. Delivery format remains inside Web Push encryption. **Add generic fallback**, retain optional worker local processing. Does not turn a PWA subscription into a native token. | [W3] |
| Own-team self-build | Paid own team + own bundle/topic + own `.p8` on own hubs. **Keep supported fallback.** Free provisioning cannot supply APNs capability; cannot use this key for App Store binary. | [A1], [A2] |
| ntfy / UnifiedPush on iOS | Ordinary iOS self-hosting cannot keep an arbitrary listener executing; ntfy iOS relies on an APNs-capable upstream for timely delivery. **Reject as this native app’s transport**: third-party ntfy credentials do not authorize our bundle, and stock ntfy cannot decode our secretbox envelope. Generic alerts in another app are an optional external workaround, not forbidden merely because a third party operates it. No question/name content may be forwarded plaintext. UnifiedPush has no ordinary iOS distributor. | [O1], [O2] |
| iMessage / SMS / Shortcuts | No supported arbitrary Node-to-iMessage background notification API for our app; Messages composition needs user interaction, SMS exposes content absent a separate protocol. Shortcuts are user-managed triggers, not an always-running tailnet listener. **Reject as product transport**; manual “check pi” shortcut may be useful. | [O3], [O4] |
| PushKit, fake audio/location/VPN keepalive | PushKit is for actual VoIP calls, not coding-agent questions; background modes must match their intended use. **Reject App Review circumvention.** A real active voice session may show local alerts, but must not be kept alive just for push. | [R1] |

## CloudKit: evidence and gaps

### Private DB from a non-Apple hub

[C1] describes HTTP CRUD for records/zones/subscriptions, API token plus user web token, and explicitly shows `CKFetchWebAuthTokenOperation` on `privateCloudDatabase`. [C2] documents endpoints of the form:

`https://api.apple-cloudkit.com/database/1/<container>/production/private/records/modify?ckAPIToken=…&ckWebAuthToken=…`

No OS restriction exists for an HTTP client. Use the user-authenticated route, **not** the server-to-server signing route: the latter grants developer access to the public DB, not the user’s private DB [C2]. Container production schema and access policies must be configured and deployed before App Store use. Test this exact native-token → Node private-record create → native-read path **[verify]**; examples alone do not establish unattended operation.

### Token lifecycle: single-use is not “copy once forever”

Current [C1]: authentication tokens are “short-lived and expire after a single use.” Archived [C2]: each request/round trip returns a new token, invalidates the previous token, and the caller must use the returned replacement. It gives **30 minutes by default**, or **two weeks if the user selects Keep me signed in in the web sign-in UI**. Do **not** apply the two-week duration to an in-app operation that presents no such choice.

These sources do not establish the actual idle/absolute lifetime or replacement-token longevity of a chain seeded by `CKFetchWebAuthTokenOperation` today. **[verify]** whether every relevant response returns a usable replacement, whether expiry slides on successful use, and whether a native-seeded chain can survive days without foregrounding the phone. An operation token is not a documented OAuth refresh token.

Design the hub as a serialized token-chain owner with an atomic persisted token generation. Never send the same token concurrently or broadcast one token to all hubs. Fetch separate seeds for hubs **[verify]** that simultaneous independently seeded chains coexist. A timeout after Apple accepts a request can lose the replacement token: lookup/retry needs a valid token, not blind reuse of a consumed token. Re-authentication may require foregrounding the app. Hub crash/restart between response and persistence is the same risk.

Do not hide expiry with silent APNs, scheduled native refresh, a pool of old seeds, or a background socket: those do not give guaranteed execution. A randomized bounded hub-side keepalive could maintain a *proven sliding* chain **[verify]**, but is not the default design: it adds perpetual CloudKit traffic and cannot repair absolute expiry or a prolonged outage. For scale illustration only, one call every 10 minutes is 144 requests/day/hub even with no alerts. [C7] warns against recurring request spikes; test capacity and policy acceptability before enabling anything like this. No extra developer service may refresh tokens.

**Release gate:** if uninterrupted native alerts require repeated foreground re-authentication on ordinary idle days, classify CloudKit as experimental/degraded, not the default dependable native notification feature. Offer the PWA; explain exactly why the native path is unavailable.

### Delivery, alert vs silent, NSE and limits

- Use `CKQuerySubscription` on `PiAttention`, predicate `destination == <random installation mailbox>`, fires-on-record-creation. `NotificationInfo`: generic title “pi”, body “Pi needs you”, default sound, `shouldSendMutableContent = true`. Do not put field values into alert localization/title templates. Configure permission and remote registration in the app.
- Visible query alerts are high-priority; setting only `shouldSendContentAvailable` produces background notifications [C3]. Silent notifications are not reliable seconds-latency wakeups; a silent push cannot invoke the NSE alert-decryption route. Use alerts even when decryption is unavailable.
- `desiredKeys` allows only three supported field types and may truncate strings longer than 100 characters [C5]. **Do not put `sealed` there**, and do not split it into three chunks. The query notification’s random record ID is the fetch locator. Payload omission/coalescing can remove fields [C3]; fall back to generic alert and foreground inbox catch-up.
- `shouldSendMutableContent` explicitly sets `mutable-content: 1` [C6]. An NSE also requires an alert; it has at most roughly 30 seconds [U1]. Parse via `CKNotification(fromRemoteNotificationDictionary:)`, check container/database/subscription and then fetch the full record using native CloudKit. NSE needs its own appropriate CloudKit/iCloud entitlements plus existing shared keychain **[verify]** on production signing. It must never depend on fetching content from a sleeping hub over Tailscale to render the alert.
- Subscriptions belong to the iCloud **user**, not an individual installation: changes notify the user’s devices [C3], [C4]. Random destination predicates select records, not APNs device targets. **[verify]** multiple installations receive each other’s generic alerts; do not assume an NSE can suppress unwanted alerts. Initial CloudKit scope is one active notification installation per iCloud account. Multi-phone support is a separate release gate, not solved by per-device ciphertext alone. PWA subscriptions remain individually targeted.
- Decrypt locally using shared keychain machine keys and existing `Envelope`/`PushContent`; validate authenticated expiry/event ID. Call the handler exactly once, including timeout and early failure. Generic original alert is safe if locked-device key access, iCloud, network, or NSE fails. Generic tap opens the inbox and reconciles; rich tap follows the decrypted machine/agent. Recheck live question state before answering.
- CloudKit notifications are change hints: coalescing, omission and excluded origin device are documented [C3], [C4]. The inbox/hub is authoritative. Measure Node-origin delivery; do not assume one banner per saved record. Duplicate alerts require local event-ID dedupe; coalesced alerts require catch-up.
- No published seconds-latency commitment or fixed usable requests/sec is established. Throttles apply to native and Web Services callers, can recur, and require honoring `retryAfter` [C7]. A write accepted by Apple is **not** an alert delivered to a person.
- Private data consumes the user’s iCloud quota [C8]; quota exhaustion blocks writes. Use tiny expiring records, bounded cleanup, and no attachments/transcripts. Archived Web Services limits include 200 operations/request and 1 MB record size [C9]; set far smaller application limits. There is no demonstrated daily alert budget/SLA for this use case **[verify]**.
- Without a signed-in/available iCloud account, native CloudKit push is unavailable. Pairing, foreground sessions, real voice sessions and local controls still work. PWA Web Push does not require an app CloudKit login [W1], but verify on an iCloud-signed-out device. Do not force iCloud sign-in or push permission just to use the app.

## Recommended architecture (gated CloudKit + existing PWA)

### Data flow

1. **Opt-in:** native app offers “Notifications via your iCloud” with explanation of ciphertext, quota and availability. Request notification permission; check `CKContainer.accountStatus`; register remote notifications. On successful setup, create random 128-bit mailbox/subscription identifiers in the user’s private DB and save a query subscription. Reconcile server state rather than trusting only a local “installed” flag.
2. **Hub enrollment:** over each existing authenticated, sealed RPC/Tailscale connection, send CloudKit container/environment/API token, random destination and a fresh per-hub web-auth seed. No keys/tokens in QR URLs, shell arguments, browser page, plaintext logs or telemetry. Only authorize already paired computers, with explicit disclosure that this credential accesses this container’s private database, not a write-only per-record capability.
3. **Attention:** hub applies current terminal presence/notification policy, builds a small event, calls `seal` with this hub’s existing paired device key, and uploads one immutable `PiAttention` record with a random record name. Per-device ciphertext; no session/model/machine names outside the envelope. Durable short-lived outbox handles transient failure without blocking pi.
4. **Alert:** CloudKit subscription sends generic mutable APNs alert using Apple-managed infrastructure. No developer signing key is involved at the hub. The NSE fetches record directly from CloudKit, decrypts locally, and optionally enriches the alert. A privacy setting keeps generic text even after decryption; default to generic previews for confidential sessions.
5. **Open/answer:** native app fetches pending mailbox records and/or reconnects to the correct hub over Tailscale, reconciles current questions, then opens the session. CloudKit never stores answers; actions remain existing sealed RPC, with existing “first answer wins” semantics. When no locator/decryption is available, show inbox rather than a broken session link.
6. **Cleanup:** app/hub batches deletion of expired/acknowledged records on ordinary activity, not a stream of per-record extra pushes. Creation-only subscription prevents cleanup alerts. On disable, remove subscription and hub enrollment, clear outstanding records where possible, and keep retrying disable reconciliation for sleeping hubs.

PWA runs separately: each hub sends RFC 8291 encrypted messages signed with its own VAPID identity to the subscription endpoint. Delivery does not require exposing a tailnet hub publicly; opening/tapping still needs Tailscale and the HTTPS origin. Choose one background notification transport per phone/hub by default to avoid duplicate native/PWA banners; an explicitly enabled backup may duplicate.

### Wire/storage proposal

```json
{
  "recordType": "PiAttention",
  "recordName": "<random-128-bit-event-record-id>",
  "fields": {
    "destination": "<random-128-bit-mailbox-id>",
    "sealed": "<seal(deviceKey, content) base64url string>"
  }
}
```

The example is logical schema, not literal Web Services field encoding; implement the documented typed `fields` dictionaries [C2]. Inside `sealed`:

```json
{
  "v": 1,
  "kind": "attention",
  "event": "<random-event-id>",
  "createdAt": 1791676800000,
  "expiresAt": 1791677400000,
  "title": "<session display name>",
  "body": "<short question preview>",
  "agent": "<session id>",
  "machine": "<hub machine id>",
  "urgent": true,
  "padding": "<optional fixed-size padding>"
}
```

Reuse `seal` unchanged: NaCl secretbox XSalsa20-Poly1305, 24-byte random nonce, authenticated box, `base64url(nonce || box)`. Do not use the test-only fixed-nonce API. Proposed limits: at most 4 KiB ciphertext string; 512-byte UTF-8 preview cap; ten-minute event validity; maximum 24-hour retention with cleanup based on CloudKit creation timestamps. These are application policies, not Apple limits. Put semantic timestamps/urgency/session correlation only inside authenticated ciphertext; CloudKit’s inherent creation/update timestamps remain observable. Optional fixed-size padding must be inside the sealed JSON, not an unauthenticated side field. The push itself carries only random locators/generic text, not this record body.

`src/crypto.ts` provides authenticity, **not notification replay handling**. Persist a bounded seen-event set shared by app/NSE, validate version/kind/types/expiry and reject unknown payloads before rich rendering. Cap per-destination pending records and upload rate; newest unresolved attention is more important than historical banners. Match the random destination to the local installation, and never accept arbitrary CloudKit record URLs/container IDs from the push.

### Token/key ownership and revocation

| Material | Holder / policy |
|---|---|
| Developer APNs `.p8` | Not used by this transport; never distributed. |
| CloudKit API token | Client-facing per-container/environment token configured in Dashboard; shipped in native setup metadata and handed to authorized hubs. Do not treat secrecy as access control. Restriction compatibility for a Node client **[verify]**. Rotate via app/config update if necessary. |
| User web-auth chain | Per-hub seed from native app; hub persists replacements atomically in a mode-0600 secret file, serialized queue, never in general `config.json` or logs. No broad iCloud password/sign-in cookie exported. |
| Session/device secretbox key | Existing per-hub/per-device pairing key in native shared keychain and hub device store; never uploaded to CloudKit. Native-seeded auth token is sealed in transit using this key. |
| Mailbox/subscription IDs | Random per-installation/account generation; metadata, not bearer authorization. Old IDs must not follow account switch. |
| User own-team APNs `.p8` | Optional self-build only; stays on own hubs, mode 0600, own topic/environment. |

Removing a paired computer deletes its local notification credentials and destination enrollment. **That is not guaranteed server-side revocation of a copied CloudKit user token.** A token may authorize other records in the same container/user DB; a destination predicate is not an ACL. Test Apple-supported token invalidation **[verify]**. Until revocation semantics are proven, disable/delete old subscriptions, rotate the mailbox generation for remaining computers and disclose the residual metadata/spam/access risk until stolen tokens expire. Removed hubs cannot decrypt other hub ciphertext unless they already possess those keys. Do not claim per-hub least privilege that the API does not provide.

Account change: cancel old native operations, drop all seeds/outboxes/subscriptions associated with that account, clear cached ciphertext and rich navigation, and re-enroll with a new mailbox only after opt-in. Never upload old-account outbox items under a new account.

## Failure modes and UX

| Failure | Behavior / recovery |
|---|---|
| Token missing/expired; replacement lost on timeout/crash | Hub marks enrollment `reauth-required`; stop futile retries. App shows “Open pi to reconnect iCloud notifications.” No remote way to guarantee renewal under constraints. PWA remains available. |
| Hub sleeps/offline or Tailscale disconnected | No new upload from sleeping hub. A previously uploaded cloud alert may still render; answers wait for direct hub connectivity. Show offline machine, do not imply question answered. |
| CloudKit throttled/service failure | Respect `retryAfter` plus jitter, bounded retries/outbox, drop expired events. Diagnostic distinction: queued, accepted, failed; never “delivered” from HTTP status alone. |
| iCloud signed out/restricted/storage full | Native notification status unavailable with actionable reason; do not disable pairing or app use. Explain cleanup/free-space/re-auth. |
| Focus/Summary/notifications disabled | Respect user settings; do not use Critical Alerts. Generic alert delivery/presentation may be delayed. No auto bypass. |
| NSE cannot access keys/fetch/decrypt within deadline | Deliver generic fallback exactly once. On open catch up via CloudKit/hubs. Test before first unlock and locked-device keychain accessibility. |
| Coalesced, duplicate, omitted locator, stale question | Reconcile inbox, dedupe IDs, check authenticated expiry, never auto-answer based on notification. Generic fallback if incomplete. |
| Reinstall/new device/subscription removed | New mailbox; re-register/reconcile at foreground and pairing changes. Delete old enrollment on known devices; bound orphan retention. |
| Abuse/malformed ciphertext from authorized writer | Limit quotas/previews/local key trials; reject unauthenticated/version-invalid events; retain safe generic alert. A stolen container token is not a secretbox key. |

Time-sensitive alerts in the current APNs sender do not imply CloudKit exposes identical controls. Do not promise that interruption level for CloudKit **[verify]**; start with ordinary alerts. NSE-side urgency/actions may depend on validated decrypted fields, but must not be marketed as bypassing Focus.

## App Store and privacy implications

CloudKit subscriptions and NSEs are public, documented features. A real encrypted private inbox is more defensible than abusing cloud storage as an unbounded push relay, but Apple has not approved this product/use case **[verify]**. Explain native auth delegated to the user’s own computers, ephemeral ciphertext storage, no developer server and no signer export in Review notes. Supply an interactive local/demo mode plus a reproducible hub setup or review video; do not require reviewers to join our private tailnet.

Follow [R1] §2.5.4 (background modes for intended purposes), §2.5.16 (notifications related to functionality), §4.5.4 (push optional; sensitive/confidential information should not be sent in push), and §5.1.1 (privacy policy/data practices). Default generic preview and explicit rich-preview opt-in reduce lock-screen exposure; ciphertext does not automatically settle Review’s confidential-notification policy. No artificial voice calls/audio, silent polling promise, or charging specifically for iCloud/push capability (§4.10).

[R2] defines collection by off-device retention/access and specifically says **you are not responsible for disclosing data collected by Apple** through Apple frameworks/services; disclose any data we collect from them. Do not conclude “Data Not Collected” merely because encryption is used. Audit the entire app, web view, voice integrations, diagnostics, dependencies and CloudKit console/access before answering labels. With no developer access to private records, no analytics and no retained developer-side identifiers, “Data Not Collected” for this notification feature is a candidate **[verify]**, not a full-app label decision. No ATT/tracking is introduced by this design. Publish a privacy policy explaining cloud ciphertext retention, iCloud quota, metadata, previews, user-owned hub credentials and deletion; do not promise Apple sees absolutely nothing.

## Verification gates (physical device, production account)

No simulator-only claim closes these gates. Use a paid development team/container, development device first, then TestFlight/production schema/signing. Include an older supported iPhone and a current iPhone on iOS 26; iOS 18.4+ for declarative tests if supported by app policy.

1. **Private Web Services auth:** fetch native seed, POST from both macOS and Linux Node to private DB, read back on phone; demonstrate user isolation, no developer/server signing key and no unintended public records. Check API token restrictions/schema permissions.
2. **Auth endurance (critical):** record only redacted status/generation timings, not tokens. Perform seed → request → replacement → next request; reject old-token reuse. Test independent hub chains/concurrency, 1 h / 24 h / 7 d idle, frequent activity, reboot and computer restart, network timeout after accepted write, logout/reinstall and explicit revocation. Establish idle versus absolute expiry. No keepalive adoption before this evidence.
3. **Native alerts:** background/suspended, force-quit, locked, low-power, cellular away from Wi-Fi, Tailscale off, iCloud signed out, fresh install, permission denied, Focus/Summary. Measure attention event → record accepted → banner and rich rewrite separately; proposed healthy-path target p95 ≤10 s, not a guarantee. Log sample counts and missing banners, not just averages.
4. **NSE:** correct CloudKit entitlement/container in extension, production `mutable-content` invocation, record fetch without main app, lost/truncated fields, inaccessible keychain before first unlock, offline/slow fetch, deadline race and exactly-once handler. Confirm generic fallback and cold-launch generic/rich tap both work.
5. **Inbox correctness:** coalesced bursts, duplicate IDs, old questions resolved elsewhere, expiry/replay, multiple hubs/phones, removed machine/account change, cleanup/outbox caps and quota exhaustion. Verify no plaintext in request/push/schema/console/logs.
6. **Capacity and policy:** CloudKit Dashboard metrics, realistic hub/device counts, `retryAfter`, storage growth/cleanup, Review feedback on delegated auth/ciphertext inbox and previews. No invented numeric service quota.
7. **PWA complement:** actual HTTPS tailnet origin installed to Home Screen, direct gesture permission, hub-owned VAPID, expired subscriptions, worker eviction/ITP, declarative generic fallback, native/PWA duplicate controls, tap with sleeping hub and iCloud-signed-out device.
8. **Local Push optional research only:** if revisited, entitlement approval, named SSID launch/stop, battery over 24 h, Tailscale routing and simultaneous VPN behavior. A VPN route may make hub reachable on a matching SSID **[verify]**, but cannot manufacture cellular/all-network activation. Current Apple documentation shows MCX matching introduced in **iOS 27**, requires special carrier plan and `mc-9500` entitlement [N3]; this is not an iOS 26 general network change.

**Go/no-go:** CloudKit only graduates when private writes, unattended auth duration matching product expectations, robust NSE fallback and measured delivery are demonstrated and Review issues addressed. If gates fail, ship App Store app with explicit PWA notification complement and own-team self-build option; ask for a relaxed constraint before adding any relay. Never silently ship a key distribution or background-mode workaround.

## Migration and implementation plan (future changes, not performed here)

1. **Feasibility spike, disposable container:** tiny native CloudKit enrollment harness and dependency-free Node Web Services client; execute gates 1–4 before integrating UX. Capture exact response token lifecycle and extension payload shape; do not log secret values. Establish policy/retention and production schema.
2. **Hub transport boundary:** add `src/cloudkit.ts` for typed HTTPS requests, serialized rotating auth, atomic secret storage, `retryAfter` and bounded outbox/cleanup. Extend `src/store.ts` enrollment state/secret references, not the general APNs config. Unit-test a fake HTTP endpoint for replacement tokens, consumed-token timeouts, persistence crashes, throttles, duplicate record IDs and auth expiry.
3. **Protocol/policy:** extend `src/hub.ts` authenticated `push` RPC and status with transport type/version (`cloudkit`, `apns-own-team`, existing `webpush`), account-generation enrollment, per-device destination, `accepted` vs `delivered`, degraded reasons, disable/revoke reconciliation. Reuse attention/presence policy and `seal`; include version/event/expiry envelope. Reject unpaired writers and avoid sending duplicate transports by default. Update `native/ios/BRIDGE.md` status semantics.
4. **Native enrollment:** add `native/ios/Pi/Core/CloudKitPush.swift`; extend `native/ios/Pi/App/PushCenter.swift` permission/account/subscription/auth reconciliation while preserving tap/voice handling. Add CloudKit capability/container and production configuration to `native/ios/project.yml`, app/extension entitlements and Info.plist as necessary. Handle account change and credential re-auth without pretending `token != nil` means delivery works. Keep cloud tokens out of WKWebView JS.
5. **NSE and envelope:** extend `native/ios/PiNotifications/NotificationService.swift` to parse CloudKit push, fetch full record asynchronously with deadline cancellation/once-only completion and generic fallback. Extend `native/ios/Pi/Core/PushContent.swift` to validate/decrypt the shared envelope, dedupe and locally derive action/routing; preserve old top-level APNs `sealed` decoder. Verify Swift/TypeScript vectors using existing crypto tests; add cold-launch/unknown-container/stale-payload tests under `native/ios/PiTests` and real-device integration coverage.
6. **PWA complement:** retain `src/webpush.ts`; feature-detect and optionally send [W3] declarative format with generic fallback plus encrypted Web Push contents and optional service-worker enhancement. Do not put agent/session/machine identifiers into `navigate` query strings; use generic inbox or an opaque local-resolved event locator. Older worker path remains compatible. Update notification settings/help and support one selected background transport per endpoint. Web UI/worker changes must first follow repo UI/design guidance.
7. **Own-team migration:** retain `src/apns.ts` and existing APNs settings for self-builds, clearly labeled “Own Apple developer team build only.” App Store builds never request `.p8` setup and do not enroll raw APNs tokens with hubs for direct delivery. Do not automatically convert existing subscriptions without opt-in; accept existing Web Push/APNs store formats. Add compile/distribution configuration to prevent displaying self-build APNs setup for the published app. Existing real voice/local Live Activities continue unchanged.
8. **Release/docs:** update `README.md`, `native/ios/README.md`, `native/ios/APP_STORE.md`, `plans/native-apps.md` §11 and the relay suggestion in `docs/native-research.md` after gates pass. Run `npm test`, `npm run typecheck`, native unit/build checks and physical TestFlight checklist. Stage opt-in rollout; rollback disables new CloudKit enrollment, leaves safe existing decoding/catch-up and PWA available. No OTA native code, no telemetry server; user-exportable diagnostics contain status/timings only, no content/identifiers/credentials.

Complexity budget: one Node transport module, one native CloudKit enrollment module, one async NSE enhancement and envelope/status extensions; no new daemon/backend/account system. Essential complexity is token-chain failure/expiry and best-effort delivery. Separate disposable feasibility work from product polish: do not build this entire stack before resolving token endurance.

## Source ledger

Checked via web search and fetched content on 2026-10-11. Apple documentation rendered dynamically was read through its public documentation JSON endpoints where needed; linked URLs below are the human-facing primary sources. Archived references are explicitly historical and must not be treated as a current service SLA.

- **[C1]** Apple, CKFetchWebAuthTokenOperation: native private DB example, short-lived/single-use auth. https://developer.apple.com/documentation/cloudkit/ckfetchwebauthtokenoperation
- **[C2]** Apple archived CloudKit Web Services, request composition: HTTP user auth, replacement token each round trip, 30-minute/two-week web durations, public-only server-to-server access. https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html
- **[C3]** Apple, CKQueryNotification: priority, silent-vs-alert behavior, coalescing/omission. https://developer.apple.com/documentation/cloudkit/ckquerynotification
- **[C4]** Apple, CKDatabaseSubscription: private/shared/custom zones and change hints. https://developer.apple.com/documentation/cloudkit/ckdatabasesubscription
- **[C5]** Apple, desiredKeys: three keys, supported types, >100-character string truncation. https://developer.apple.com/documentation/cloudkit/cksubscription/notificationinfo-swift.class/desiredkeys
- **[C6]** Apple, shouldSendMutableContent: NSE flag. https://developer.apple.com/documentation/cloudkit/cksubscription/notificationinfo-swift.class/shouldsendmutablecontent
- **[C7]** Apple TN3162, Understanding CloudKit throttles: dynamic limits and retry-after. https://developer.apple.com/documentation/technotes/tn3162-understanding-cloudkit-throttles
- **[C8]** Apple, privateCloudDatabase: account access and user iCloud storage quota. https://developer.apple.com/documentation/cloudkit/ckcontainer/privateclouddatabase
- **[C9]** Apple archived Web Services size limits. https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/PropertyMetrics.html
- **[U1]** Apple, UNNotificationServiceExtension: mutable alert and limited execution time. https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension
- **[N1]** Apple, Local Push Connectivity: restricted networks, persistent extension, requested entitlement, local notifications. https://developer.apple.com/documentation/networkextension/local-push-connectivity
- **[N2]** Apple, matchSSIDs: named Wi-Fi networks only, 1–10. https://developer.apple.com/documentation/networkextension/neapppushmanager/matchssids
- **[N3]** Apple, matchMissionCriticalService: iOS 27, MCX carrier/entitlement restrictions. https://developer.apple.com/documentation/networkextension/neapppushmanager/matchmissioncriticalservice
- **[L1]** Apple, starting/updating Live Activities via APNs. https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- **[L2]** Apple, broadcast push notification requests. https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns
- **[A1]** Apple, APNs token-based connection authentication. https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- **[A2]** Apple, supported iOS capabilities. https://developer.apple.com/help/account/reference/supported-capabilities-ios
- **[B1]** Apple, background tasks scheduling. https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtask
- **[B2]** Apple, choosing background strategies. https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app
- **[W1]** WebKit (Apple), Home Screen Web Push iOS 16.4, permission and no developer membership required. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- **[W2]** WebKit (Apple), Meet Web Push. https://webkit.org/blog/12945/meet-web-push/
- **[W3]** WebKit (Apple), Declarative Web Push: iOS 18.4, generic fallback and optional worker. https://webkit.org/blog/16535/meet-declarative-web-push/
- **[O1]** ntfy documentation, iOS instant notifications and upstream forwarding (project primary source). https://docs.ntfy.sh/config/#ios-instant-notifications
- **[O2]** UnifiedPush project, iOS platform limitations. https://unifiedpush.org/users/faq/
- **[O3]** Apple, message compose controller. https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller
- **[O4]** Apple, Shortcuts personal automation triggers. https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios
- **[R1]** Apple, App Review Guidelines. https://developer.apple.com/app-store/review/guidelines/
- **[R2]** Apple, App Privacy Details: collection definition and Apple-framework/service disclosure guidance. https://developer.apple.com/app-store/app-privacy-details/
