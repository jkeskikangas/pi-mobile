# Notifications for the App Store app: an open-source push relay

**Date:** 2026-10-11. **Status:** accepted; relay implemented in `relay/`. Hub and app integration still to do. **Scope:** App Store iPhone app (and a future Android build), user-owned macOS/Linux Node hubs.

## Decision

Run a **small, stateless, open-source push relay** as a Cloudflare Worker (`relay/`). It holds the developer's APNs key (and optionally an FCM service account) and forwards **sealed** payloads that it cannot read. Hubs never get the key. The phone gets a generic alert, and its Notification Service Extension decrypts the real title and body locally.

- The Safari Home Screen PWA keeps relay-free **Web Push** as the alternative. It needs no relay.
- **Self-builds** keep direct APNs with the user's own team key (`src/apns.ts`), or deploy their own copy of the relay.

Why a relay: Apple only accepts pushes for the App Store app's topic when they are signed with our team's key, and that key must never ship inside the npm package or the app. All the relay-free native options either fail on reliability (CloudKit token chains) or depend on a closed service (Expo); see the table. A relay that is open source, keeps no state and sees only ciphertext is the smallest trust we can ask for.

## Design

```
phone ──(native token)──▶ hub ──POST /v1/register──▶ relay ──▶ {cap}
        (over the existing sealed Tailscale RPC)        stores nothing
hub (attention) ──POST /v1/send {cap, sealed, urgent}──▶ relay ──HTTP/2──▶ APNs ──▶ NSE opens `sealed`
```

**Secrets** (Worker secrets, never committed): `APNS_KEY` (.p8 PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (bundle ID), `CAP_KEY` (32-byte AES-GCM key, base64), optional `FCM_SERVICE_ACCOUNT` (JSON).

**`POST /v1/register`** `{platform:"apns"|"fcm", token, sandbox?}` returns `{cap}`, where `cap = base64url(iv ‖ AES-GCM(CAP_KEY, {v:1, p, t, s, iat, rid}))`. The cap is a stateless capability: whoever holds it can make the relay push generic alerts to that one device. The random `rid` makes every registration distinct. Registration is rate-limited per IP.

**`POST /v1/send`** `{cap, sealed, urgent?, collapse?}`:

- **APNs.** Body: `{aps:{alert:{title:"pi",body:"New activity"}, "mutable-content":1, sound:"default", "interruption-level": urgent?"time-sensitive":"active"}, sealed}`. Headers: `apns-push-type: alert`, `apns-priority` 10 (urgent) or 5, `apns-expiration` now+1 h, `apns-collapse-id`.
- **FCM.** HTTP v1 high-priority data message `{data:{sealed}}`, TTL 1 h.
- **Size.** Payloads are capped at 4 KB, otherwise `413`.
- **Token caches.** The ES256 provider JWT is cached per isolate for up to 50 minutes. On `ExpiredProviderToken` the relay signs a new one and retries once. The FCM OAuth token is cached until five minutes before it expires.
- **Dead devices.** APNs `410` / `BadDeviceToken` / `DeviceTokenNotForTopic` / `Unregistered`, FCM `UNREGISTERED`, or a cap the relay can't open all return `410 {gone:true}`, and the hub deletes that cap.
- **Throttling.** An upstream `429` passes through with `retry-after`. Sends are rate-limited per device, keyed by a hash of the platform and token, so minting more caps doesn't bypass the limit.
- **No logging.** The relay never logs bodies, caps or tokens (enforced by a test), and Workers observability is off.

`GET /` is a health check. There is no CORS: the callers are hubs, not browsers.

**Inside `sealed`** nothing changes: `seal(deviceKey, {title, body, agent, machine?})` from `src/crypto.ts` (NaCl secretbox). The NSE already expects a top-level `sealed`.

### What the relay can and can't see

- **Sees:** the device token, the hub's IP address, timing, the urgent flag, the ciphertext length and the generic alert text.
- **Can't see:** session names, questions or answers, because it never holds a pairing key.
- **Cloudflare, Apple and Google** see the usual traffic metadata.
- **A leaked cap** lets someone send rate-limited "New activity" alerts to one phone and nothing more. Rotating `CAP_KEY` revokes all caps, and phones re-register on next launch.

### HTTP/2 on Workers

APNs requires HTTP/2, and Worker code can't choose the protocol. On deployed Workers, outbound `fetch` goes through Cloudflare's proxy, which upgrades to HTTP/2 when it talks to the origin. A workerd maintainer confirmed this, and noted that local workerd (`wrangler dev`) has no HTTP/2 client, so APNs fails there [H1]. edgepush sends APNs from Workers with plain `fetch` [H2]. Cloudflare doesn't document this as a guarantee, so `relay/scripts/smoke.mjs` checks it after every deploy: it sends to a bogus all-zero token and expects Apple's `BadDeviceToken`, which Apple only returns after accepting the HTTP/2 connection, the JWT and the topic.

### Free tier

The Workers Free plan allows 100,000 requests/day, 10 ms CPU per request (time spent waiting on `fetch` doesn't count) and 50 subrequests per request [F1]. Each send uses one subrequest, plus one for the OAuth token on FCM's first send per isolate. The Workers rate limiting binding is available on Free, with 10 s or 60 s windows and counters that are per location and eventually consistent [F2]. That's good enough for abuse damping, not for exact quotas. Running out of the daily quota returns Cloudflare error 1027, which hubs treat as a failed send.

## Hub and app integration

1. **App (to do):** the App Store build calls the relay's `POST /v1/register {platform:"apns", token, sandbox}` itself. It then sends `push {relay: {url, cap}}` over the sealed RPC to every paired hub, and re-registers when a hub reports `relayOn: false`. Self-builds keep `push {apns: {token, sandbox}}`.
2. **Hub (done, `src/relay.ts`):**
   - It stores `{url, cap}` per device. The URL must be https; there is no default, the URL always comes from the phone.
   - On attention it posts `{cap, sealed, urgent}` with a 10 s timeout.
   - A `410` drops the cap, a `429` pauses that relay until `Retry-After`, and revoking a device drops its cap.
3. **Docs and privacy:** `PRIVACY.md` and the App Store notes name the relay, what it sees, and that it's open source and self-hostable.

## Options considered

| Option | Verdict | Sources |
|---|---|---|
| **Open-source stateless relay on Workers** | **Chosen.** The developer key stays in one place, the relay sees ciphertext only and keeps no state, the Free plan is enough, and anyone can audit or self-host it. | [H1], [H2], [F1], [F2] |
| CloudKit private DB + query subscription | Rejected for now. It needs no developer server, but the hub's web-auth token chain is single-use and expires (30 min by default), so it would need re-authentication in the foreground: a fragile token chain. | [C1], [C2], [C3] |
| Expo push service | Rejected. It's a closed hosted service, and the native token registration endpoint it needs is undocumented. | [X1] |
| Own-team self-build, direct APNs | Kept for self-builds. The App Store topic can't use it. | [A1], [A2] |
| Safari Home Screen PWA Web Push (+ declarative) | Kept as the relay-free path. Each hub uses its own VAPID key. | [W1], [W2], [W3] |
| Local Push Connectivity | Rejected. It only works on named Wi-Fi networks and needs a special entitlement. | [N1], [N2], [N3] |
| Live Activity push / broadcast | Rejected. It still needs our APNs key. | [L1], [L2] |
| `BGAppRefreshTask` polling | Rejected. The system decides when it runs, so it can't deliver within seconds. | [B1], [B2] |
| ntfy / UnifiedPush | Rejected. Neither can push to our bundle, and UnifiedPush has no iOS distributor. | [O1], [O2] |
| iMessage / SMS / Shortcuts | Rejected. There's no background API, and content would be exposed. | [O3], [O4] |
| PushKit or fake background modes | Rejected. That would circumvent App Review. | [R1] |

## App Store and privacy

- Push stays optional (§4.5.4), and the alert text stays generic. Rich text appears only after the phone decrypts it.
- The privacy policy discloses the relay: who runs it, what it sees and that it keeps nothing. The App Privacy label must account for the device token reaching our relay [R1], [R2].

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
- **[H1]** cloudflare/workerd #4841: APNs over `fetch()` works on deployed Workers (Cloudflare's proxy upgrades to HTTP/2) but not in local workerd. https://github.com/cloudflare/workerd/issues/4841
- **[H2]** edgepush, open-source APNs/FCM sender on Workers using plain `fetch`. https://github.com/akshitkrnagpal/edgepush/blob/main/packages/server/src/push/apns.ts
- **[F1]** Cloudflare Workers limits (Free: 100k requests/day, 10 ms CPU, 50 subrequests). https://developers.cloudflare.com/workers/platform/limits/
- **[F2]** Cloudflare Workers rate limiting binding (10/60 s periods, per-location counters). https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **[X1]** Expo, sending push notifications through Expo's push service. https://docs.expo.dev/push-notifications/sending-notifications/
