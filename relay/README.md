# pi push relay

A small open-source Cloudflare Worker that delivers lock-screen notifications to the **App Store** pi app (APNs) and, optionally, an Android build (FCM).

Why it exists: Apple only accepts pushes for an app's topic when they are signed with that app developer's key. Your pi hub runs on your computer, and the developer's `.p8` key must never ship to it. So one small service holds the key and forwards pushes. It knows nothing else. Self-built apps can skip it entirely: give the hub your own key (`src/apns.ts`).

Design and alternatives: [`designs/notifications.md`](../designs/notifications.md).

## API

| Request | Response |
|---|---|
| `GET /` | `pi push relay: ok` |
| `POST /v1/register` `{platform:"apns"\|"fcm", token, sandbox?}` | `{cap}`: an opaque capability for this device |
| `POST /v1/send` `{cap, sealed, urgent?, collapse?}` | `200 {ok}` · `410 {gone:true}` (drop the cap) · `429` with `retry-after` · `413` (over 4 KB) · `502 {reason}` (Apple/Google said no) |

- **cap** = `base64url(iv ‖ AES-256-GCM(CAP_KEY, {v:1, p, t, s, iat, rid}))`. The relay is **stateless**: no database, no account, no list of devices. Only this relay can open a cap, and hubs never see the raw token.
- **APNs** gets `{aps:{alert:{title:"pi",body:"New activity"}, "mutable-content":1, sound:"default", "interruption-level": urgent ? "time-sensitive" : "active"}, sealed}` with `apns-push-type: alert`, `apns-priority: 10` (urgent) or `5`, `apns-expiration` one hour out, and `apns-collapse-id` when given. The phone's Notification Service Extension opens `sealed` and replaces the generic text.
- **FCM** gets a high-priority data message `{data:{sealed}}` with a one-hour TTL.
- A dead token (APNs `410`, `BadDeviceToken`, `DeviceTokenNotForTopic`; FCM `UNREGISTERED`/404), or a cap this relay can't open, returns **410** so the hub forgets it.

## Privacy model

What the relay sees per push: the device token (inside the cap), ciphertext sealed to a key that only the phone and your computer hold (`src/crypto.ts`: NaCl secretbox), the generic text "pi / New activity", whether it is urgent, the hub's IP address and the time. It never sees session names, questions, answers or anything else from pi. The code never logs bodies, caps or tokens (a test enforces "no `console.`"), and `wrangler.toml` turns Workers observability off. Cloudflare still sees request metadata as the operator of the network. Apple and Google see the token, the generic alert and the ciphertext.

What a stolen cap allows: sending generic "New activity" alerts to that one phone, up to the per-device rate limit. It can't read anything. Rotating `CAP_KEY` revokes every cap.

## Deploy

You need a Cloudflare account (the Free plan is enough). For APNs you also need the app's APNs auth key (`AuthKey_XXXXXXXXXX.p8`, from Apple Developer → Keys, with APNs enabled), its key ID, your team ID and the app's bundle ID.

```sh
cd relay
npm install                      # wrangler, dev only
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put CAP_KEY
npx wrangler secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8
echo -n XXXXXXXXXX | npx wrangler secret put APNS_KEY_ID
echo -n YOURTEAMID | npx wrangler secret put APNS_TEAM_ID
echo -n dev.pi-mobile.app | npx wrangler secret put APNS_TOPIC
# Optional, Android: a Firebase service account with the FCM role
npx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
npx wrangler deploy
node scripts/smoke.mjs https://pi-push-relay.<your-subdomain>.workers.dev
```

The smoke check registers an all-zero device token and sends to it. Apple only answers `BadDeviceToken` after it has accepted the HTTP/2 connection, the provider token and the topic, so `410 {gone:true}` means everything works. Use `--sandbox` for a development build.

Run the tests with `npm test` here, or `npm run test:relay` from the repo root. `npm run check` bundles without deploying.

The `namespace_id` values in `wrangler.toml` only need to be unique within your account.

### HTTP/2

APNs only speaks HTTP/2. Worker code can't choose the protocol, and local `wrangler dev` (workerd) has no HTTP/2 client, so **APNs sends fail locally**. On deployed Workers they work: requests leave through Cloudflare's proxy, which negotiates HTTP/2 with the origin. A workerd maintainer confirmed this behaviour ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)), and [edgepush](https://github.com/akshitkrnagpal/edgepush/blob/main/packages/server/src/push/apns.ts) sends APNs this way with plain `fetch`. Cloudflare doesn't document it as a guarantee, so run `scripts/smoke.mjs` after every deploy.

## Free-plan limits

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-10-11:

- **100,000 requests/day** per account, reset at 00:00 UTC. Every register or send counts as one. One APNs or FCM call is one subrequest, against a limit of 50 per request. FCM's first send per isolate costs one more, for the OAuth token.
- **10 ms CPU** per request. Waiting on `fetch` doesn't count. The ES256 signature is cached for 50 minutes per isolate and the FCM access token for about 55 minutes, so a typical send is one AES-GCM decrypt plus JSON.
- **Rate limiting binding** ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)): it's on the Free plan and needs wrangler ≥ 4.36. The window is 10 s or 60 s. Counters are **per Cloudflare location and eventually consistent**, so treat them as abuse damping, not exact quotas. Configured here: `register` allows 10/min per IP, and `send` allows 30/min per device, keyed by a hash of the device token so that minting more caps doesn't reset it.

## Self-hosting

A self-built app has its own bundle ID and team. You can either point the hub straight at Apple with your own key (no relay at all), or deploy this Worker with your own secrets and point your hubs at its URL. Either way, no one else's key or server is involved.

## Rotating `CAP_KEY`

```sh
openssl rand -base64 32 | npx wrangler secret put CAP_KEY
```

Every existing cap stops opening, so `/v1/send` returns `410 {gone:true}`. Hubs drop their caps, and phones register again the next time the app opens. Do this if a cap leaked or on a schedule. Rotating the APNs key works the same way (put new `APNS_KEY`/`APNS_KEY_ID`, revoke the old key at Apple) and doesn't invalidate caps.
