import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApnsClient, type ApnsMessage, type ApnsToken } from "../src/apns.ts";
import { open } from "../src/crypto.ts";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "remote-apns-"));
	dirs.push(d);
	return d;
}

const TOKEN = "ab".repeat(32);

function p8(): { file: string; publicKey: ReturnType<typeof createPublicKey> } {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const file = join(tmp(), "AuthKey_ABCDE12345.p8");
	writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }));
	return { file, publicKey };
}

interface Seen {
	headers: Record<string, any>;
	body: string;
}

async function fakeApple(reply: (path: string) => [number, unknown?]): Promise<{ server: Http2Server; origin: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer();
	server.on("stream", (stream: ServerHttp2Stream, headers) => {
		let body = "";
		stream.setEncoding("utf8");
		stream.on("data", (c) => (body += c));
		stream.on("end", () => {
			seen.push({ headers, body });
			const [status, json] = reply(String(headers[":path"]));
			stream.respond({ ":status": status });
			stream.end(json ? JSON.stringify(json) : undefined);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("APNs: ES256 provider token, request path, headers and body; 410 and BadDeviceToken mean gone", async () => {
	const { file, publicKey } = p8();
	const prod = await fakeApple((path) => (path.endsWith("dead".repeat(16)) ? [410, { reason: "Unregistered" }] : [200]));
	const sandbox = await fakeApple(() => [400, { reason: "BadDeviceToken" }]);
	const client = new ApnsClient(
		{ keyFile: file, keyId: "ABCDE12345", teamId: "TEAM123456", topic: "dev.pi.mobile" },
		{ production: prod.origin, sandbox: sandbox.origin },
	);
	try {
		const msg: ApnsMessage = { sealed: "SEALED", urgent: true };
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		const [req] = prod.seen;
		assert.equal(req.headers[":method"], "POST");
		assert.equal(req.headers[":path"], `/3/device/${TOKEN}`);
		assert.equal(req.headers["apns-topic"], "dev.pi.mobile");
		assert.equal(req.headers["apns-push-type"], "alert");
		assert.deepEqual(JSON.parse(req.body), {
			aps: { alert: { title: "pi", body: "New activity" }, "mutable-content": 1, sound: "default", "interruption-level": "time-sensitive" },
			sealed: "SEALED",
		});
		const jwt = String(req.headers.authorization).replace(/^bearer /, "");
		const [h, c, s] = jwt.split(".");
		assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "ABCDE12345" });
		const claims = JSON.parse(Buffer.from(c, "base64url").toString());
		assert.equal(claims.iss, "TEAM123456");
		assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
		assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));

		// One token for 30 minutes, then a fresh one.
		const t0 = client.providerToken();
		assert.equal(t0, jwt);
		assert.equal(client.providerToken(Date.now() + 29 * 60_000), t0);
		assert.notEqual(client.providerToken(Date.now() + 31 * 60_000), t0);

		assert.equal(await client.send({ token: "dead".repeat(16) }, msg), "gone");
		assert.equal(await client.send({ token: TOKEN, sandbox: true }, msg), "gone", "sandbox tokens go to the sandbox host");
		assert.equal(sandbox.seen.length, 1);
	} finally {
		client.close();
		prod.server.close();
		sandbox.server.close();
	}
});

test("APNs: one connection is reused; reconnects after GOAWAY or a dead connection; timeouts fail; close shuts down", async () => {
	const { file } = p8();
	let mode: "ok" | "goaway" | "hang" = "ok";
	const sessions = new Set<unknown>();
	const seen: string[] = [];
	const server = createServer();
	server.on("session", (s) => sessions.add(s));
	server.on("stream", (stream: ServerHttp2Stream, headers) => {
		stream.resume();
		stream.on("end", () => {
			seen.push(String(headers[":path"]));
			if (mode === "hang") return;
			stream.respond({ ":status": 200 });
			stream.end();
			if (mode === "goaway") stream.session?.goaway();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new ApnsClient({ keyFile: file, keyId: "K", teamId: "T", topic: "t" }, { production: origin, sandbox: origin }, 300);
	const msg = { sealed: "x" };
	try {
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		assert.equal(sessions.size, 1, "reuses the HTTP/2 connection");
		mode = "goaway";
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		mode = "ok";
		await until(() => client.connections === 0);
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		assert.equal(sessions.size, 2, "reconnects after GOAWAY");
		mode = "hang";
		assert.equal(await client.send({ token: TOKEN }, msg), "failed", "times out");
		assert.equal(client.connections, 0, "drops a connection that timed out");
		mode = "ok";
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		assert.equal(sessions.size, 3);
		client.close();
		assert.equal(client.connections, 0, "close shuts every connection");
	} finally {
		client.close();
		server.close();
	}
});

test("APNs: DeviceTokenNotForTopic is gone; ExpiredProviderToken re-signs and retries once; config.sandbox is the default", async () => {
	const { file } = p8();
	const replies: [number, unknown?][] = [];
	const prod = await fakeApple(() => replies.shift() ?? [200]);
	const sandbox = await fakeApple(() => [200]);
	const client = new ApnsClient({ keyFile: file, keyId: "K", teamId: "T", topic: "t", sandbox: true }, { production: prod.origin, sandbox: sandbox.origin });
	const msg = { sealed: "x" };
	try {
		assert.equal(await client.send({ token: TOKEN }, msg), "sent");
		assert.equal(sandbox.seen.length, 1, "no per-token flag: the configured sandbox default");
		assert.equal(prod.seen.length, 0);

		replies.push([400, { reason: "DeviceTokenNotForTopic" }]);
		assert.equal(await client.send({ token: TOKEN, sandbox: false }, msg), "gone");

		const before = client.providerToken();
		await new Promise((r) => setTimeout(r, 1100)); // a new iat second, so the re-signed token differs
		replies.push([403, { reason: "ExpiredProviderToken" }]);
		assert.equal(await client.send({ token: TOKEN, sandbox: false }, msg), "sent");
		const [first, retry] = prod.seen.slice(-2).map((s) => s.headers.authorization);
		assert.equal(first, `bearer ${before}`);
		assert.notEqual(retry, first, "retried with a fresh provider token");

		replies.push([403, { reason: "ExpiredProviderToken" }], [403, { reason: "ExpiredProviderToken" }]);
		const n = prod.seen.length;
		assert.equal(await client.send({ token: TOKEN, sandbox: false }, msg), "failed");
		assert.equal(prod.seen.length, n + 2, "retries only once");
	} finally {
		client.close();
		prod.server.close();
		sandbox.server.close();
	}
});

test("attention reaches iPhone tokens with a generic alert and the text sealed to the device key; gone tokens are dropped", async () => {
	const port = await freePort();
	const dir = tmp();
	const push = new PushStore(dir);
	const sent: { token: ApnsToken; msg: ApnsMessage }[] = [];
	const apns = { send: async (token: ApnsToken, msg: ApnsMessage) => (sent.push({ token, msg }), "gone" as const) } as unknown as ApnsClient;
	const hub = new Hub({ config: { port, expose: "local", enabled: false }, secret: "s".repeat(43), devices: new DeviceStore(dir), push, apns });
	await hub.listen();
	const link = new HubLink({
		config: () => ({ port, expose: "local", enabled: false }),
		secret: "s".repeat(43),
		info: () => ({ agent: "A", pid: 1, sessionId: "sess", name: "session A", cwd: "/tmp", status: "idle" }),
		onRequest: () => null,
	});
	link.start();
	try {
		await until(() => link.linked);
		const phone = new Phone();
		await phone.pair(hub.createPairing().links[0].url, "iphone");
		const h = await phone.rpc("hub");
		assert.equal(h.apns, true);
		assert.equal(h.apnsOn, false);
		await assert.rejects(phone.rpc("push", { apns: { token: "nothex" } }), /invalid/);
		await assert.rejects(phone.rpc("push", { apns: { token: TOKEN, sandbox: "yes" } }), /invalid/);
		await phone.rpc("push", { apns: { token: TOKEN } });
		assert.deepEqual(push.apnsEntries()[0][1], { token: TOKEN }, "no sandbox flag: the machine's config decides");
		assert.deepEqual(await phone.rpc("push", { apns: { token: TOKEN, sandbox: true } }), { ok: true, apns: true });
		assert.equal((await phone.rpc("hub")).apnsOn, true);

		link.send({ t: "attention", title: "proj asks", body: "Allow rm?", urgent: true });
		await until(() => sent.length === 1);
		assert.deepEqual(sent[0].token, { token: TOKEN, sandbox: true });
		assert.equal("thread" in sent[0].msg, false, "no plaintext session id for Apple");
		assert.equal(sent[0].msg.urgent, true);
		assert.deepEqual(open(phone.key, sent[0].msg.sealed)?.value, { title: "proj asks", body: "Allow rm?", agent: "A", machine: h.machine.id });
		await until(() => push.apnsEntries().length === 0);
	} finally {
		link.stop();
		hub.close();
	}
});
