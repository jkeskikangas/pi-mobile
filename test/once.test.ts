import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ReplayGuard } from "../src/crypto.ts";
import { actionKey, Once } from "../src/once.ts";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-once-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("Once: a key runs once, concurrent and later repeats share the first outcome for at least 10 minutes", async () => {
	const once = new Once();
	let runs = 0;
	const t0 = 1_000_000;
	const fn = async () => ({ n: ++runs });
	const [a, b] = await Promise.all([once.run("k", fn, t0), once.run("k", fn, t0)]);
	assert.deepEqual([a, b, runs], [{ n: 1 }, { n: 1 }, 1]);
	assert.deepEqual(await once.run("k", fn, t0 + 14 * 60_000), { n: 1 });
	assert.deepEqual(await once.run("k", fn, t0 + 16 * 60_000), { n: 2 }, "forgotten after the TTL");
	assert.deepEqual(await once.run("other", fn, t0), { n: 3 });

	const fail = () => Promise.reject(new Error("already answered"));
	await assert.rejects(once.run("e", fail, t0), /already answered/);
	await assert.rejects(once.run("e", () => "ok", t0), /already answered/, "a repeat reports the original outcome");
	assert.equal(actionKey("abcd1234"), "abcd1234");
	for (const bad of ["short", "x".repeat(65), "a b c d e f", 42, undefined]) assert.equal(actionKey(bad), undefined);
});

test("ReplayGuard with a file: the next hub process rejects requests the previous one saw", () => {
	const file = join(dir, "seen.json");
	const now = Date.now();
	const a = new ReplayGuard(undefined, file);
	assert.equal(a.accept("nonce-1", now, now), true);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const b = new ReplayGuard(undefined, file);
	assert.equal(b.accept("nonce-1", now, now + 1000), false, "replayed after the move");
	assert.equal(b.accept("nonce-2", now, now + 1000), true);
	assert.equal(new ReplayGuard().accept("nonce-1", now, now), true, "no file, no memory (tests, pairing helpers)");
});

test("a captured request to a session can't be replayed after the hub moves to another pi process", async () => {
	const port = await freePort();
	const state = mkdtempSync(join(dir, "hub-"));
	const secret = "s".repeat(43);
	const sent: string[] = [];
	const link = new HubLink({
		config: () => ({ port, enabled: false }),
		secret,
		info: () => ({ agent: "A", pid: 1, sessionId: "s", name: "A", cwd: "/tmp", status: "idle" }),
		onRequest: (m, p) => (sent.push(p.text), { ok: true }),
	});
	const start = async () => {
		const hub = new Hub({ config: { port, enabled: false }, secret, devices: new DeviceStore(state), push: new PushStore(state) });
		await hub.listen();
		return hub;
	};
	let hub = await start();
	link.start();
	try {
		await until(() => link.linked);
		const phone = new Phone();
		await phone.pair(hub.createPairing().links[0].url, "iphone");
		const captured = phone.body("agent", { agent: "A", m: "send", p: { text: "deploy" } });
		assert.equal((await phone.raw(captured)).status, 200);
		assert.equal((await phone.raw(captured)).status, 401);
		hub.close();
		await until(() => !link.linked);
		hub = await start(); // the next pi process takes over the hub
		await until(() => link.linked, 10_000);
		assert.equal((await phone.raw(captured)).status, 401, "replay after the move is refused");
		assert.deepEqual(sent, ["deploy"]);
	} finally {
		link.stop();
		hub.close();
	}
});
