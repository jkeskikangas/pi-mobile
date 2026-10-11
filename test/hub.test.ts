import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hub } from "../src/hub.ts";
import { HubLink, closeProcessHub, processHub } from "../src/link.ts";
import { type AgentInfo, PROTOCOL } from "../src/protocol.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dirs: string[] = [];
after(() => {
	closeProcessHub();
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "remote-hub-"));
	dirs.push(d);
	return d;
}
const SECRET = "s".repeat(43);
const info = (agent: string): AgentInfo => ({ agent, pid: 1, sessionId: "sess", name: `session ${agent}`, cwd: "/tmp", status: "idle" });

async function setup() {
	const port = await freePort();
	const hub = new Hub({ config: { port, enabled: false }, secret: SECRET, devices: new DeviceStore(tmp()) });
	await hub.listen();
	const calls: any[] = [];
	const link = new HubLink({
		config: () => ({ port, enabled: false }),
		secret: SECRET,
		info: () => info("A"),
		onRequest: (m, p) => {
			calls.push({ m, p });
			if (m === "fail") throw new Error("boom");
			return { echoed: m };
		},
	});
	link.start();
	await until(() => link.linked);
	return { hub, link, calls, port };
}

test("pairing, encrypted rpc, routing to the linked pi, and streaming with replay", async () => {
	const { hub, link, calls } = await setup();
	try {
		const index = await fetch(`http://127.0.0.1:${hub.port}/`);
		assert.equal(index.status, 200);
		assert.match(await index.text(), /pi mobile/);
		assert.equal((await fetch(`http://127.0.0.1:${hub.port}/nacl.js`)).status, 200);
		assert.equal((await fetch(`http://127.0.0.1:${hub.port}/../package.json`)).status, 404);

		const pairing = hub.createPairing();
		const phone = new Phone();
		assert.equal((await phone.pair(pairing.links[0].url)).status, 200);
		assert.equal(phone.role, "control");
		assert.equal((await new Phone().pair(pairing.links[0].url)).status, 410, "pairing codes are single use");

		const h = await phone.rpc("hub");
		assert.deepEqual(h.agents.map((a: AgentInfo) => a.agent), ["A"]);
		assert.equal(h.protocol, PROTOCOL);
		assert.deepEqual(h.features, ["voice", "voiceSession", "speak", "voices", "learn", "machines"]);
		assert.deepEqual(await phone.rpc("agent", { agent: "A", m: "snapshot", p: { limit: 5 } }), { echoed: "snapshot" });
		assert.deepEqual(calls.at(-1).p, { limit: 5, _device: { id: phone.d, name: "test phone" } });
		await assert.rejects(phone.rpc("agent", { agent: "A", m: "fail" }), /boom/);
		await assert.rejects(phone.rpc("agent", { agent: "nope", m: "x" }), /no longer connected/);

		// A captured request cannot be replayed.
		const body = phone.body("hub");
		assert.equal((await phone.raw(body)).status, 200);
		assert.equal((await phone.raw(body)).status, 401);

		const hello = await phone.stream(undefined, "A");
		assert.equal(hello.resync, true);
		link.send({ t: "ev", ev: { type: "notice", level: "info", text: "one", n: 1 } });
		const ev = await phone.waitFor((e) => e.type === "notice");
		assert.equal(ev.agent, "A");
		assert.equal(ev.n, 1);
		phone.close();

		link.send({ t: "ev", ev: { type: "notice", level: "info", text: "two", n: 2 } });
		await new Promise((r) => setTimeout(r, 50));
		const replay = new Phone();
		Object.assign(replay, { base: phone.base, d: phone.d, key: phone.key });
		const hello2 = await replay.stream({ hub: hub.id, seq: ev.seq }, "A");
		assert.equal(hello2.resync, false);
		const missed = await replay.waitFor((e) => e.type === "notice" && e.text === "two");
		assert.ok(missed.seq > ev.seq);
		assert.equal(replay.events.some((e) => e.text === "one"), false, "only events after `since` are replayed");
		replay.close();

		// Revocation takes effect immediately.
		await phone.rpc("revoke", { ids: [phone.d] });
		await assert.rejects(phone.rpc("hub"), /401/);
	} finally {
		link.stop();
		hub.close();
	}
});

test("the agent link requires the local secret", async () => {
	const { hub, link, port } = await setup();
	try {
		const status = await new Promise<number>((resolve) => {
			const req = request({ host: "127.0.0.1", port, headers: { connection: "Upgrade", upgrade: "pi-mobile-link", "x-pi-mobile-secret": "wrong" } });
			req.on("upgrade", () => resolve(101));
			req.on("response", (res) => resolve(res.statusCode ?? 0));
			req.on("error", () => resolve(-1));
			req.end();
		});
		assert.notEqual(status, 101);
		const bad = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: "POST", body: JSON.stringify({ d: "x", b: "y" }) });
		assert.equal(bad.status, 401);
	} finally {
		link.stop();
		hub.close();
	}
});

test("pi processes elect a hub and fail over when its host goes away", async () => {
	const port = await freePort();
	const config = () => ({ port, enabled: false });
	const a = new HubLink({ config, secret: SECRET, info: () => info("A"), onRequest: () => "a" });
	const b = new HubLink({ config, secret: SECRET, info: () => info("B"), onRequest: () => "b" });
	a.start();
	b.start();
	try {
		await until(() => a.linked && b.linked);
		const first = processHub();
		assert.ok(first, "one of them hosts the hub");
		const status = await a.request("status");
		assert.deepEqual(status.agents.map((x: AgentInfo) => x.agent).sort(), ["A", "B"]);

		// A pi that stops sharing disappears from the hub (no half-open ghost).
		const c = new HubLink({ config, secret: SECRET, info: () => info("C"), onRequest: () => "c" });
		c.start();
		await until(() => c.linked);
		c.stop();
		await until(() => false === (first as any).agents.has("C"), 3000);

		closeProcessHub(); // the hosting pi exits
		await until(() => !a.linked || !b.linked, 2000).catch(() => {});
		await until(() => a.linked && b.linked && !!processHub() && processHub() !== first, 8000);
		const again = await b.request("status");
		assert.deepEqual(again.agents.map((x: AgentInfo) => x.agent).sort(), ["A", "B"]);
	} finally {
		a.stop();
		b.stop();
		closeProcessHub();
	}
});

test("a port held by something else is reported, not hijacked", async () => {
	const { createServer } = await import("node:http");
	const port = await freePort();
	const other = createServer((_q, r) => r.end("hello")).listen(port, "127.0.0.1");
	await new Promise((r) => other.once("listening", r));
	const states: string[] = [];
	const link = new HubLink({
		config: () => ({ port, enabled: false }),
		secret: SECRET,
		info: () => info("A"),
		onRequest: () => null,
		onState: (s) => states.push(s.kind === "error" ? s.message : s.kind),
	});
	link.start();
	try {
		await until(() => states.some((s) => /not a pi-mobile hub/.test(s)));
	} finally {
		link.stop();
		other.close();
	}
});

test("attention reaches subscribed devices as Web Push; dead and revoked subscriptions are dropped", async () => {
	const port = await freePort();
	const dir = tmp();
	const sent: { endpoint: string; payload: any; urgency: string }[] = [];
	const push = new PushStore(dir);
	const hub = new Hub({
		config: { port, enabled: false },
		secret: SECRET,
		devices: new DeviceStore(dir),
		push,
		sendPush: async (sub, payload, _v, urgency) => {
			sent.push({ endpoint: sub.endpoint, payload, urgency: urgency ?? "normal" });
			return sub.endpoint.endsWith("/gone") ? "gone" : "sent";
		},
	});
	await hub.listen();
	const link = new HubLink({ config: () => ({ port, enabled: false }), secret: SECRET, info: () => info("A"), onRequest: () => null });
	link.start();
	try {
		await until(() => link.linked);
		const a = new Phone();
		const b = new Phone();
		await a.pair(hub.createPairing().links[0].url, "a");
		await b.pair(hub.createPairing().links[0].url, "b");
		const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
		const h = await a.rpc("hub");
		assert.equal(h.pushKey, push.vapid.publicKey);
		assert.equal(h.pushOn, false);
		await assert.rejects(a.rpc("push", { subscription: { endpoint: "http://insecure", keys } }), /invalid/);
		await a.rpc("push", { subscription: { endpoint: "https://push.example/a", keys } });
		await b.rpc("push", { subscription: { endpoint: "https://push.example/gone", keys } });
		assert.equal((await a.rpc("hub")).pushOn, true);

		link.send({ t: "attention", title: "proj asks", body: "Allow rm?", urgent: true });
		await until(() => sent.length === 2);
		assert.deepEqual(sent.find((x) => x.endpoint.endsWith("/a")), { endpoint: "https://push.example/a", payload: { title: "proj asks", body: "Allow rm?", agent: "A", machine: h.machine.id }, urgency: "high" });
		await until(() => push.entries().length === 1);

		await a.rpc("revoke", { ids: [a.d] });
		assert.equal(push.entries().length, 0, "revoking a device drops its subscription");
	} finally {
		link.stop();
		hub.close();
	}
});

test("ten sessions: one pairing sees all; detailed events flow only for the focused one", async () => {
	const port = await freePort();
	const hub = new Hub({ config: { port, enabled: false }, secret: SECRET, devices: new DeviceStore(tmp()) });
	await hub.listen();
	const links = Array.from({ length: 10 }, (_, i) => {
		const l = new HubLink({ config: () => ({ port, enabled: false }), secret: SECRET, info: () => info(`S${i}`), onRequest: () => null });
		l.start();
		return l;
	});
	try {
		await until(() => links.every((l) => l.linked));
		const phone = new Phone();
		await phone.pair(hub.createPairing().links[0].url);
		assert.equal((await phone.rpc("hub")).agents.length, 10);
		const hello = await phone.stream(undefined, "S3");
		for (const [i, l] of links.entries()) {
			l.send({ t: "ev", ev: { type: "stream", key: `k${i}`, i: 0, kind: "text", delta: "x", n: 1 } });
			l.send({ t: "ev", ev: { type: "prompt", prompt: { id: `p${i}`, kind: "confirm", title: `q${i}` }, n: 2 } });
		}
		await until(() => phone.events.filter((e) => e.type === "prompt").length === 10);
		assert.deepEqual(
			phone.events.filter((e) => e.type === "stream").map((e) => e.agent),
			["S3"],
			"token streams of the other nine sessions are not sent",
		);
		// Switching sessions moves the detail stream with it.
		await phone.rpc("focus", { client: hello.client, agent: "S7" });
		phone.events = [];
		for (const l of links) l.send({ t: "ev", ev: { type: "stream", key: "k", i: 0, kind: "text", delta: "y", n: 3 } });
		await phone.waitFor((e) => e.type === "stream");
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(phone.events.map((e) => e.agent), ["S7"]);
		phone.close();
	} finally {
		for (const l of links) l.stop();
		hub.close();
	}
});

test("devices paired with the removed view-only role are locked out", async () => {
	const { writeFileSync } = await import("node:fs");
	const dir = tmp();
	writeFileSync(
		join(dir, "devices.json"),
		JSON.stringify([
			{ id: "old", name: "old viewer", key: "a".repeat(43), role: "view", createdAt: 1 },
			{ id: "ok", name: "phone", key: "b".repeat(43), role: "control", createdAt: 1 },
		]),
	);
	const store = new DeviceStore(dir);
	assert.deepEqual(
		store.list().map((d) => d.id),
		["ok"],
	);
	assert.equal(store.get("old"), undefined);
});
