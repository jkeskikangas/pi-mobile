import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { open } from "../src/crypto.ts";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { isRelayTarget, RelayClient, relayUrl, retryAfterMs } from "../src/relay.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "pi-relay-"));
	dirs.push(d);
	return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CAP = "c".repeat(60);
const URL_ = "https://relay.example.dev";

interface Call {
	url: string;
	init: RequestInit;
}
function fakeFetch(answer: (n: number) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const f = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return answer(calls.length);
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("relay URL: https only, no credentials/query/fragment, normalized", () => {
	assert.equal(relayUrl("https://relay.example.dev/"), "https://relay.example.dev");
	assert.equal(relayUrl("https://relay.example.dev/base/"), "https://relay.example.dev/base");
	for (const bad of ["http://relay.example.dev", "https://u:p@relay.example.dev", "https://r.dev/?x=1", "https://r.dev/#f", "javascript:alert(1)", "", 42, null])
		assert.equal(relayUrl(bad), undefined, String(bad));
	assert.ok(isRelayTarget({ url: URL_, cap: CAP }));
	assert.ok(!isRelayTarget({ url: URL_, cap: "short" }));
	assert.ok(!isRelayTarget({ url: URL_, cap: "x".repeat(50) + "!" }));
	assert.ok(!isRelayTarget({ url: "http://r.dev", cap: CAP }));
});

test("relay send: request shape; 410 gone; 429 pauses that relay until Retry-After; timeout and 5xx fail", async () => {
	const statuses = [200, 410, 429, 502];
	const { f, calls } = fakeFetch((n) => new Response("{}", { status: statuses[n - 1] ?? 200, headers: n === 3 ? { "retry-after": "30" } : {} }));
	const c = new RelayClient(f);
	const now = 1_000_000;
	assert.equal(await c.send({ url: URL_ + "/", cap: CAP }, { sealed: "S", urgent: true }, now), "sent");
	assert.equal(calls[0]!.url, `${URL_}/v1/send`);
	assert.equal(calls[0]!.init.method, "POST");
	assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/json");
	assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { cap: CAP, sealed: "S", urgent: true });
	assert.ok(calls[0]!.init.signal instanceof AbortSignal);
	assert.equal(await c.send({ url: URL_, cap: CAP }, { sealed: "S" }, now), "gone");
	assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { cap: CAP, sealed: "S" });
	assert.equal(await c.send({ url: URL_, cap: CAP }, { sealed: "S" }, now), "limited");
	assert.equal(await c.send({ url: URL_, cap: CAP }, { sealed: "S" }, now + 29_000), "limited");
	assert.equal(calls.length, 3, "skipped while paused");
	assert.equal(await c.send({ url: URL_, cap: CAP }, { sealed: "S" }, now + 31_000), "failed");
	assert.equal(calls.length, 4);

	const slow = new RelayClient(((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch, 30);
	assert.equal(await slow.send({ url: URL_, cap: CAP }, { sealed: "S" }), "failed");
	assert.equal(retryAfterMs(null), 60_000);
	assert.equal(retryAfterMs("5"), 5000);
	assert.equal(retryAfterMs("99999"), 3_600_000);
});

test("attention reaches relay caps with only sealed text; push RPC validates; 410 and revoke drop the cap", async () => {
	const port = await freePort();
	const dir = tmp();
	const push = new PushStore(dir);
	let status = 200;
	const { f, calls } = fakeFetch(() => new Response("{}", { status }));
	const hub = new Hub({ config: { port, enabled: false }, secret: "s".repeat(43), devices: new DeviceStore(dir), push, relay: new RelayClient(f) });
	await hub.listen();
	const link = new HubLink({
		config: () => ({ port, enabled: false }),
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
		assert.equal(h.relay, true);
		assert.equal(h.relayOn, false);
		await assert.rejects(phone.rpc("push", { relay: { url: "http://relay.example.dev", cap: CAP } }), /invalid push relay/);
		await assert.rejects(phone.rpc("push", { relay: { url: URL_, cap: "x" } }), /invalid push relay/);
		assert.deepEqual(await phone.rpc("push", { relay: { url: URL_ + "/", cap: CAP } }), { ok: true, apns: false, relay: true, relayOn: true });
		assert.deepEqual(push.relayEntries()[0]![1], { url: URL_, cap: CAP });
		assert.equal((await phone.rpc("hub")).relayOn, true);

		link.send({ t: "attention", title: "proj asks", body: "Allow rm?", urgent: true });
		await until(() => calls.length === 1);
		const body = JSON.parse(calls[0]!.init.body as string);
		assert.deepEqual(Object.keys(body).sort(), ["cap", "sealed", "urgent"], "nothing in plaintext beyond the sealed blob");
		assert.ok(!(calls[0]!.init.body as string).includes("proj asks"));
		assert.deepEqual(open(phone.key, body.sealed)?.value, { title: "proj asks", body: "Allow rm?", agent: "A", machine: h.machine.id });

		status = 410;
		link.send({ t: "attention", title: "again", body: "x" });
		await until(() => push.relayEntries().length === 0);

		await phone.rpc("push", { relay: { url: URL_, cap: CAP } });
		assert.deepEqual((await phone.rpc("push", { relay: null })).relayOn, false);
		await phone.rpc("push", { relay: { url: URL_, cap: CAP } });
		await phone.rpc("revoke", { ids: [phone.d] });
		assert.equal(push.relayEntries().length, 0);
	} finally {
		link.stop();
		hub.close();
	}
});
