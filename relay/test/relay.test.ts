import assert from "node:assert/strict";
import { test } from "node:test";
import { apnsHeaders, apnsPayload, ApnsSigner } from "../src/apns.ts";
import { b64u, unb64 } from "../src/b64.ts";
import { importCapKey, openCap, sealCap } from "../src/cap.ts";
import { fcmAssertion, FCM_SCOPE } from "../src/fcm.ts";
import { importRs256 } from "../src/jwt.ts";
import { createRelay, type Env } from "../src/index.ts";

const pem = (der: ArrayBuffer) => `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;

const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const EC_PEM = pem(await crypto.subtle.exportKey("pkcs8", ec.privateKey));
const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const RSA_PEM = pem(await crypto.subtle.exportKey("pkcs8", rsa.privateKey));
const CAP_KEY = b64u(crypto.getRandomValues(new Uint8Array(32)));
const SA = { project_id: "proj-1", client_email: "relay@proj-1.iam.gserviceaccount.com", private_key: RSA_PEM, token_uri: "https://oauth2.googleapis.com/token" };
const TOKEN = "ab".repeat(32);

const env = (over: Partial<Env> = {}): Env => ({
	CAP_KEY,
	APNS_KEY: EC_PEM,
	APNS_KEY_ID: "KEY1234567",
	APNS_TEAM_ID: "TEAM123456",
	APNS_TOPIC: "dev.pi.mobile",
	FCM_SERVICE_ACCOUNT: JSON.stringify(SA),
	...over,
});

const parts = (jwt: string) => {
	const [h, c, s] = jwt.split(".");
	return { header: JSON.parse(new TextDecoder().decode(unb64(h!))), claims: JSON.parse(new TextDecoder().decode(unb64(c!))), signed: new TextEncoder().encode(`${h}.${c}`), sig: unb64(s!) };
};

interface Call {
	url: string;
	init: RequestInit;
}
/** Fake fetch: records calls, answers from a queue. */
function fakeFetch(...answers: (Response | (() => Response))[]) {
	const calls: Call[] = [];
	const f = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		const a = answers.shift() ?? new Response(null, { status: 200 });
		return typeof a === "function" ? a() : a;
	}) as unknown as typeof fetch;
	return { f, calls };
}

const post = (path: string, body: unknown) => new Request(`https://relay.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function capFor(relay: ReturnType<typeof createRelay>, e: Env, body: unknown = { platform: "apns", token: TOKEN }) {
	const r = await relay.fetch(post("/v1/register", body), e);
	assert.equal(r.status, 200);
	return ((await r.json()) as { cap: string }).cap;
}

test("APNs provider JWT: ES256 header/claims verify with the public key, cached", async () => {
	const signer = new ApnsSigner(env() as Required<Env>);
	const now = 1_800_000_000_000;
	const jwt = await signer.token(now);
	const { header, claims, signed, sig } = parts(jwt);
	assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567" });
	assert.deepEqual(claims, { iss: "TEAM123456", iat: now / 1000 });
	assert.equal(sig.length, 64);
	assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, sig, signed));
	assert.equal(await signer.token(now + 49 * 60_000), jwt, "reused within 50 min");
	assert.notEqual(await signer.token(now + 51 * 60_000), jwt, "re-signed after 50 min");
});

test("cap round-trips and rejects tampering, other keys and garbage", async () => {
	const key = await importCapKey(CAP_KEY);
	const cap = await sealCap(key, { p: "apns", t: TOKEN, s: true });
	assert.deepEqual(await openCap(key, cap), { p: "apns", t: TOKEN, s: true });
	assert.notEqual(await sealCap(key, { p: "apns", t: TOKEN, s: true }), cap, "random iv/rid");
	assert.ok(!cap.includes(TOKEN));
	const raw = unb64(cap);
	raw[20]! ^= 1;
	assert.equal(await openCap(key, b64u(raw)), undefined);
	const other = await importCapKey(b64u(crypto.getRandomValues(new Uint8Array(32))));
	assert.equal(await openCap(other, cap), undefined);
	assert.equal(await openCap(key, "!!!"), undefined);
	assert.equal(await openCap(key, ""), undefined);
	await assert.rejects(importCapKey(b64u(new Uint8Array(16))));
});

test("register validates input and only for configured platforms", async () => {
	const relay = createRelay(fakeFetch().f);
	assert.equal((await relay.fetch(post("/v1/register", { platform: "apns", token: "nothex" }), env())).status, 400);
	assert.equal((await relay.fetch(post("/v1/register", { platform: "x", token: TOKEN }), env())).status, 400);
	assert.equal((await relay.fetch(post("/v1/register", { platform: "fcm", token: "f".repeat(40) }), env({ FCM_SERVICE_ACCOUNT: undefined }))).status, 501);
	assert.equal((await relay.fetch(new Request("https://relay.test/"), env())).status, 200);
	assert.equal((await relay.fetch(new Request("https://relay.test/v1/send"), env())).status, 404);
	assert.equal((await relay.fetch(post("/v1/send", {}), env({ CAP_KEY: "short" }))).status, 500);
});

test("APNs request shape: URL, headers, payload; urgent vs normal", async () => {
	const { f, calls } = fakeFetch();
	const relay = createRelay(f);
	const e = env();
	const cap = await capFor(relay, e, { platform: "apns", token: TOKEN, sandbox: true });
	const before = Math.floor(Date.now() / 1000);
	let r = await relay.fetch(post("/v1/send", { cap, sealed: "SEALED", urgent: true, collapse: "c1" }), e);
	assert.equal(r.status, 200);
	const c = calls[0]!;
	assert.equal(c.url, `https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
	assert.equal(c.init.method, "POST");
	const h = c.init.headers as Record<string, string>;
	assert.equal(h["apns-topic"], "dev.pi.mobile");
	assert.equal(h["apns-push-type"], "alert");
	assert.equal(h["apns-priority"], "10");
	assert.equal(h["apns-collapse-id"], "c1");
	const exp = Number(h["apns-expiration"]);
	assert.ok(exp >= before + 3600 && exp <= before + 3601);
	assert.match(h.authorization!, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
	assert.deepEqual(JSON.parse(c.init.body as string), {
		aps: { alert: { title: "pi", body: "New activity" }, "mutable-content": 1, sound: "default", "interruption-level": "time-sensitive" },
		sealed: "SEALED",
	});
	const prodCap = await capFor(relay, e);
	r = await relay.fetch(post("/v1/send", { cap: prodCap, sealed: "S" }), e);
	assert.equal(r.status, 200);
	assert.equal(calls[1]!.url, `https://api.push.apple.com/3/device/${TOKEN}`);
	assert.equal((calls[1]!.init.headers as Record<string, string>)["apns-priority"], "5");
	assert.equal((calls[1]!.init.headers as Record<string, string>)["apns-collapse-id"], undefined);
	assert.equal((apnsPayload({ sealed: "S" }) as { aps: Record<string, unknown> }).aps["interruption-level"], "active");
	assert.equal(apnsHeaders("j", "t", { sealed: "S" }, 0)["apns-expiration"], "3600");
});

test("APNs 410 / BadDeviceToken / Unregistered map to 410 {gone}; bad caps too", async () => {
	const { f } = fakeFetch(
		new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }),
		new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 }),
		new Response(JSON.stringify({ reason: "BadTopic" }), { status: 400 }),
	);
	const relay = createRelay(f);
	const e = env();
	const cap = await capFor(relay, e);
	for (let i = 0; i < 2; i++) {
		const r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
		assert.equal(r.status, 410);
		assert.deepEqual(await r.json(), { gone: true });
	}
	const r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
	assert.equal(r.status, 502);
	assert.equal(((await r.json()) as { reason: string }).reason, "BadTopic");
	const forged = await relay.fetch(post("/v1/send", { cap: cap.slice(0, -2) + "AA", sealed: "S" }), e);
	assert.equal(forged.status, 410);
});

test("429 passes through with retry-after; expired provider token is retried once with a fresh JWT", async () => {
	const { f, calls } = fakeFetch(
		new Response(JSON.stringify({ reason: "TooManyRequests" }), { status: 429, headers: { "retry-after": "30" } }),
		new Response(JSON.stringify({ reason: "ExpiredProviderToken" }), { status: 403 }),
		new Response(null, { status: 200 }),
	);
	const relay = createRelay(f);
	const e = env();
	const cap = await capFor(relay, e);
	let r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
	assert.equal(r.status, 429);
	assert.equal(r.headers.get("retry-after"), "30");
	r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
	assert.equal(r.status, 200);
	assert.equal(calls.length, 3);
});

test("payloads over 4 KB are refused before reaching Apple", async () => {
	const { f, calls } = fakeFetch();
	const relay = createRelay(f);
	const e = env();
	const cap = await capFor(relay, e);
	const overhead = JSON.stringify(apnsPayload({ sealed: "" })).length;
	assert.equal((await relay.fetch(post("/v1/send", { cap, sealed: "x".repeat(4096 - overhead) }), e)).status, 200);
	assert.equal((await relay.fetch(post("/v1/send", { cap, sealed: "x".repeat(4097 - overhead) }), e)).status, 413);
	assert.equal(calls.length, 1);
});

test("rate limit bindings: per IP on register, per device on send", async () => {
	const keys: string[] = [];
	const deny = { limit: async (o: { key: string }) => (keys.push(o.key), { success: false }) };
	const relay = createRelay(fakeFetch().f);
	const cap = await capFor(relay, env());
	const e = env({ REGISTER_LIMIT: deny, SEND_LIMIT: deny });
	assert.equal((await relay.fetch(post("/v1/register", { platform: "apns", token: TOKEN }), e)).status, 429);
	const r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
	assert.equal(r.status, 429);
	assert.match(keys[1]!, /^s:[0-9a-f]{32}$/);
	assert.ok(!keys.join().includes(TOKEN));
});

test("FCM: OAuth JWT assertion verifies; v1 message is a high-priority data message", async () => {
	const now = 1_800_000_000_000;
	const assertion = await fcmAssertion(await importRs256(RSA_PEM), SA, now);
	const { header, claims, signed, sig } = parts(assertion);
	assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
	assert.deepEqual(claims, { iss: SA.client_email, scope: FCM_SCOPE, aud: SA.token_uri, iat: now / 1000, exp: now / 1000 + 3600 });
	assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rsa.publicKey, sig, signed));

	const { f, calls } = fakeFetch(
		new Response(JSON.stringify({ access_token: "ya29.tok", expires_in: 3599 })),
		new Response(JSON.stringify({ name: "projects/proj-1/messages/1" })),
		new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 }),
	);
	const relay = createRelay(f);
	const e = env();
	const fcmToken = "fcm:" + "x".repeat(60);
	const cap = await capFor(relay, e, { platform: "fcm", token: fcmToken, sandbox: true });
	assert.equal((await relay.fetch(post("/v1/send", { cap, sealed: "SEALED", urgent: true, collapse: "c" }), e)).status, 200);
	assert.equal(calls[0]!.url, "https://oauth2.googleapis.com/token");
	const form = new URLSearchParams(calls[0]!.init.body as string);
	assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
	assert.equal(parts(form.get("assertion")!).claims.scope, FCM_SCOPE);
	assert.equal(calls[1]!.url, "https://fcm.googleapis.com/v1/projects/proj-1/messages:send");
	assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer ya29.tok");
	assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
		message: { token: fcmToken, data: { sealed: "SEALED", urgent: "1" }, android: { priority: "HIGH", ttl: "3600s", collapse_key: "c" } },
	});
	// Access token cached; UNREGISTERED → gone.
	const r = await relay.fetch(post("/v1/send", { cap, sealed: "S" }), e);
	assert.equal(r.status, 410);
	assert.equal(calls.length, 3);
});

test("the relay never logs", async () => {
	const src = await import("node:fs").then((fs) => ["index", "apns", "fcm", "cap", "jwt", "b64"].map((n) => fs.readFileSync(new URL(`../src/${n}.ts`, import.meta.url), "utf8")).join("\n"));
	assert.doesNotMatch(src, /console\./);
});
