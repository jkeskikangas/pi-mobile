// The phone's machine list (web/fleet.js) against real hubs: one list from two machines, routing by
// machine, a machine going away without touching the other, and coming back.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { open, seal, unb64u } from "../src/crypto.ts";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import type { AgentInfo } from "../src/protocol.ts";
import { DeviceStore, machineIdentity, OfferStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

// A browser script, not a module: importing runs it and it sets globalThis.PiFleet.
const script = "../web/fleet.js";
await import(script);
const { createFleet } = (globalThis as any).PiFleet;

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
after(() => {
	for (const f of cleanup.reverse()) f();
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "remote-fleet-"));
	dirs.push(d);
	return d;
}
const info = (agent: string, name: string): AgentInfo => ({ agent, pid: 1, sessionId: "s", name, cwd: "/tmp", status: "idle" });

/** One machine: a hub with its own state, one pi session linked to it. */
async function machine(name: string, agent: string, port?: number, dir = tmp()) {
	writeFileSync(join(dir, "machine.json"), JSON.stringify({ id: `${name}-id`, name }));
	port ??= await freePort();
	const secret = `${name}`.padEnd(43, "x");
	const hub = new Hub({
		config: { port, enabled: true },
		secret,
		devices: new DeviceStore(dir),
		push: new PushStore(dir),
		offers: new OfferStore(dir),
		machine: machineIdentity(dir),
	});
	await hub.listen();
	const calls: string[] = [];
	const link = new HubLink({
		config: () => ({ port: port!, enabled: true }),
		secret,
		info: () => info(agent, `${name} session`),
		onRequest: (m) => {
			calls.push(m);
			return { from: name, m };
		},
	});
	link.start();
	await until(() => link.linked);
	const stop = () => {
		link.stop();
		hub.close();
	};
	cleanup.push(stop);
	return { hub, link, calls, port, dir, url: `http://127.0.0.1:${port}`, stop };
}

function phoneFleet(origin: string, seed: Record<string, unknown> = {}) {
	const mem = new Map<string, unknown>(Object.entries(seed));
	const events: { id: string; ev: any }[] = [];
	const states: string[] = [];
	const revoked: string[] = [];
	const fleet = createFleet({
		seal,
		open: (k: Uint8Array, s: string) => {
			const o = open<any>(k, s);
			if (!o) throw new Error("could not decrypt");
			return o.value;
		},
		unb64u,
		fetch,
		origin,
		storage: { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: unknown) => (v == null ? mem.delete(k) : mem.set(k, v)) },
		onHello: async (id: string) => {
			const hub = await fleet.rpc(id, "hub");
			fleet.identify(id, hub.machine);
			fleet.adopt(id, hub.agents.map((a: AgentInfo) => a.agent));
		},
		onEvent: (id: string, ev: any) => events.push({ id, ev }),
		onState: (id: string) => states.push(`${id}:${fleet.state(id)}`),
		onRevoked: (id: string) => revoked.push(id),
	});
	cleanup.push(() => fleet.stop());
	return { fleet, mem, events, states, revoked };
}

/** Pairs a test phone with a hub and returns the device (as the app stores it). */
async function pairWith(hub: Hub) {
	const p = new Phone();
	await p.pair(hub.createPairing().links[0].url, "iPhone");
	return { d: p.d, k: Buffer.from(p.key).toString("base64url") };
}

test("a single pairing from before becomes the primary machine, and learns who it is", async () => {
	const laptop = await machine("laptop", "A");
	const dev = await pairWith(laptop.hub);
	const { fleet, mem } = phoneFleet(laptop.url, { "pi-mobile-device": { ...dev, role: "control", host: "laptop" } });
	assert.equal(fleet.machines.length, 1);
	assert.equal(fleet.primary().d, dev.d);
	fleet.start();
	await until(() => fleet.machines[0].machine === "laptop-id");
	assert.equal(fleet.machineOf("A"), fleet.primary().id);
	assert.deepEqual(await fleet.call("A", "snapshot", {}), { from: "laptop", m: "snapshot" });
	assert.equal((mem.get("pi-mobile-machines") as any[]).length, 1);
	assert.equal((mem.get("pi-mobile-device") as any).d, dev.d, "the single-pairing key stays for older code");
});

test("two machines in one list: calls route by session, and one going away leaves the other alone", async () => {
	const laptop = await machine("laptop", "A");
	const box = await machine("box", "B");
	const { fleet, events } = phoneFleet(laptop.url);
	fleet.add({ ...(await pairWith(laptop.hub)), primary: true });
	const boxEntry = fleet.add({ ...(await pairWith(box.hub)), machine: "box-id", name: "box", origin: box.url });
	fleet.start();
	await until(() => fleet.machineOf("A") && fleet.machineOf("B"));
	assert.deepEqual(await fleet.call("B", "status", {}), { from: "box", m: "status" });
	assert.deepEqual(await fleet.call("A", "status", {}), { from: "laptop", m: "status" });
	assert.deepEqual(box.calls, ["status"]);
	assert.deepEqual(laptop.calls, ["status"]);

	// Detailed events only from the machine of the session on screen.
	await fleet.focus("B");
	box.link.send({ t: "ev", ev: { type: "stream_start", messageId: "m1" } });
	laptop.link.send({ t: "ev", ev: { type: "stream_start", messageId: "m2" } });
	await until(() => events.some((e) => e.ev.type === "stream_start"));
	await new Promise((r) => setTimeout(r, 150));
	assert.deepEqual(
		events.filter((e) => e.ev.type === "stream_start").map((e) => e.ev.agent),
		["B"],
	);

	// The box goes away: only its machine goes offline; the laptop still answers.
	box.stop();
	await until(() => fleet.state(boxEntry.id) === "offline");
	assert.equal(fleet.state(fleet.primary().id), "online");
	assert.deepEqual(await fleet.call("A", "status", {}), { from: "laptop", m: "status" });
	await assert.rejects(fleet.call("B", "status", {}), /box is offline/);

	// It comes back on the same address with the same state: the phone reconnects within seconds.
	const again = await machine("box", "B", box.port, box.dir);
	await until(() => fleet.state(boxEntry.id) === "online", 10_000);
	await until(() => !!fleet.machineOf("B"));
	assert.deepEqual(await fleet.call("B", "status", {}), { from: "box", m: "status" });
	assert.deepEqual(again.calls, ["status"]);
});

test("a machine that revokes this phone is reported; removing one forgets its sessions", async () => {
	const laptop = await machine("laptop", "A");
	const box = await machine("box", "B");
	const { fleet, revoked } = phoneFleet(laptop.url);
	fleet.add({ ...(await pairWith(laptop.hub)), primary: true });
	const dev = await pairWith(box.hub);
	const entry = fleet.add({ ...dev, machine: "box-id", name: "box", origin: box.url });
	fleet.start();
	await until(() => !!fleet.machineOf("B"));

	await fleet.rpc(entry.id, "revoke", { ids: [dev.d] });
	await until(() => revoked.includes(entry.id));
	assert.equal(fleet.state(entry.id), "revoked");

	assert.deepEqual(fleet.remove(entry.id), ["B"]);
	assert.equal(fleet.machines.length, 1);
	assert.equal(fleet.machineOf("B"), undefined);
});

test("adding the same computer again replaces it instead of listing it twice", async () => {
	const laptop = await machine("laptop", "A");
	const box = await machine("box", "B");
	const { fleet } = phoneFleet(laptop.url);
	fleet.add({ ...(await pairWith(laptop.hub)), primary: true });
	fleet.add({ ...(await pairWith(box.hub)), machine: "box-id", name: "box", origin: box.url });
	fleet.add({ ...(await pairWith(box.hub)), machine: "box-id", name: "box", origin: `${box.url}/` });
	assert.deepEqual(
		fleet.machines.map((m: any) => [m.machine, m.origin]),
		[
			["", ""],
			["box-id", box.url],
		],
	);
});
