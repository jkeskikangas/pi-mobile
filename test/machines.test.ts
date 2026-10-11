// Several machines: `pi-mobile add` enrols a machine over ssh, the files it writes are the ones the
// hub reads, and the phone gets the offer on its stream. Also CORS, CSP and the shared push key.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Hub } from "../src/hub.ts";
import { DeviceStore, machineIdentity, OfferStore, PushStore } from "../src/store.ts";
import { generateVapid } from "../src/webpush.ts";
import { freePort, Phone } from "./phone.ts";

// A plain-JS command (no TypeScript loader on a fresh box), imported as data for its functions.
const BIN = fileURLToPath(new URL("../bin/pi-mobile.mjs", import.meta.url));
const cli: any = await import(BIN);

const dirs: string[] = [];
const hubs: Hub[] = [];
after(() => {
	for (const h of hubs) h.close();
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "remote-machines-"));
	dirs.push(d);
	return d;
}
const SECRET = "s".repeat(43);
const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "BNcR".padEnd(87, "A"), auth: "tBHI".padEnd(22, "A") } };

/** A machine with a running hub, its own state dir and machine identity, and a paired phone. */
async function machineWithPhone(name: string) {
	const dir = tmp();
	writeFileSync(join(dir, "machine.json"), JSON.stringify({ id: `${name}-id`, name }));
	const port = await freePort();
	const pushed: any[] = [];
	const hub = new Hub({
		config: { port, enabled: true },
		secret: SECRET,
		devices: new DeviceStore(dir),
		push: new PushStore(dir),
		offers: new OfferStore(dir),
		machine: machineIdentity(dir),
		sendPush: async (sub, payload) => {
			pushed.push({ sub, payload });
			return "sent" as const;
		},
	});
	await hub.listen();
	hubs.push(hub);
	const phone = new Phone();
	await phone.pair(hub.createPairing().links[0].url, "iPhone · Safari");
	await phone.rpc("push", { subscription: SUB });
	return { dir, hub, phone, pushed };
}

test("add enrols a machine the hub can serve, and the phone gets the offer", async () => {
	const laptop = await machineWithPhone("laptop");
	const boxDir = tmp();
	writeFileSync(join(boxDir, "machine.json"), JSON.stringify({ id: "box-id", name: "box" }));

	const seen: any[] = [];
	const r = await cli.add(
		"box",
		{
			origin: "https://box.tail1.ts.net",
			tailnet: "laptop.tail1.ts.net",
			run: async (host: string, input: any) => {
				seen.push({ host, input });
				return cli.enrol(input, boxDir);
			},
		},
		laptop.dir,
	);
	assert.equal(r.machine.name, "box");
	assert.deepEqual(r.phones, ["iPhone · Safari"]);
	assert.equal(seen[0].input.from, "laptop");
	assert.equal(seen[0].input.phones[0].sub.endpoint, SUB.endpoint, "the phone's subscription travels to the box");

	// The box: sharing on, the laptop's push key, one device for the phone with its subscription.
	assert.equal(JSON.parse(readFileSync(join(boxDir, "config.json"), "utf8")).enabled, true);
	const boxPush = new PushStore(boxDir);
	assert.equal(boxPush.vapid.publicKey, new PushStore(laptop.dir).vapid.publicKey, "every machine signs with the same key");
	const boxDevices = new DeviceStore(boxDir).list();
	assert.equal(boxDevices.length, 1);
	assert.equal(boxPush.entries()[0][0], boxDevices[0].id);

	// The phone's offer waits on the laptop and arrives on its stream.
	await laptop.phone.stream();
	const offer = (await laptop.phone.waitFor((e) => e.type === "machine_offer")).offer;
	assert.equal(offer.kind, "add");
	assert.equal(offer.machine.name, "box");
	assert.equal(offer.origin, "https://box.tail1.ts.net");
	assert.equal(offer.from, "laptop");

	// The key in the offer opens the box's hub, as the phone's own device there.
	const port = await freePort();
	const boxHub = new Hub({
		config: { port, enabled: true },
		secret: SECRET,
		devices: new DeviceStore(boxDir),
		push: boxPush,
		offers: new OfferStore(boxDir),
		machine: machineIdentity(boxDir),
	});
	await boxHub.listen();
	hubs.push(boxHub);
	const onBox = new Phone();
	onBox.base = `http://127.0.0.1:${port}`;
	onBox.d = offer.d;
	onBox.key = new Uint8Array(Buffer.from(offer.k, "base64url"));
	const hello = await onBox.rpc("hub");
	assert.deepEqual(hello.machine, { id: "box-id", name: "box" });
	assert.equal(hello.pushKey, boxPush.vapid.publicKey);

	// Acknowledged offers are gone for good.
	assert.deepEqual(await laptop.phone.rpc("offerDone", { id: offer.id }), { ok: true });
	assert.equal(new OfferStore(laptop.dir).list().length, 0);
	assert.deepEqual(cli.knownMachines(laptop.dir).map((m: any) => m.name), ["box"]);
	laptop.phone.close();

	// Removing it queues a removal for every phone.
	cli.remove("box", laptop.dir);
	const [removal] = new OfferStore(laptop.dir).list();
	assert.equal(removal.kind, "remove");
	assert.equal(removal.machine.id, "box-id");
	assert.deepEqual(cli.knownMachines(laptop.dir), []);
});

test("add refuses addresses outside your tailnet, itself, and computers without a paired phone", async () => {
	const laptop = await machineWithPhone("laptop");
	const elsewhere = { origin: "https://box.evil.example", tailnet: "laptop.tail1.ts.net", run: async (_h: string, input: any) => cli.enrol(input, tmp()) };
	await assert.rejects(cli.add("box", elsewhere, laptop.dir), /isn't on your tailnet/);
	await cli.add("box", { ...elsewhere, allowOrigin: true }, laptop.dir);
	await assert.rejects(
		cli.add("self", { origin: "https://laptop.tail1.ts.net", tailnet: "laptop.tail1.ts.net", run: async (_h: string, input: any) => cli.enrol(input, laptop.dir) }, laptop.dir),
		/is this computer/,
	);
	await assert.rejects(cli.add("box", elsewhere, tmp()), /no phone is paired/);
});

test("enrol keeps a different push key that other phones already use, unless forced", async () => {
	const box = tmp();
	const other = generateVapid();
	writeFileSync(join(box, "push.json"), JSON.stringify({ vapid: other, subs: { someone: SUB } }));
	const input = { from: "laptop", origin: "https://box.tail1.ts.net", vapid: generateVapid(), phones: [{ id: "p", name: "phone" }] };
	await assert.rejects(cli.enrol(input, box), /different key/);
	await cli.enrol({ ...input, force: true }, box);
	assert.equal(new PushStore(box).vapid.publicKey, input.vapid.publicKey);
});

test("over ssh, keys travel on stdin and stdout only", async () => {
	const laptop = await machineWithPhone("laptop");
	const box = tmp();
	const argvFile = join(tmp(), "argv");
	// A stand-in for ssh: records its arguments, then runs the command on "the box".
	const ssh = join(tmp(), "ssh");
	writeFileSync(ssh, `#!/bin/sh\necho "$@" > "${argvFile}"\nPI_CODING_AGENT_DIR="${box}" exec "${process.execPath}" "${BIN}" enrol\n`);
	chmodSync(ssh, 0o755);
	process.env.PI_MOBILE_SSH = ssh;
	try {
		const r = await cli.add("box.example", { origin: "https://box.tail1.ts.net", tailnet: "laptop.tail1.ts.net" }, laptop.dir);
		assert.equal(r.machine.name.length > 0, true);
	} finally {
		delete process.env.PI_MOBILE_SSH;
	}
	const argv = readFileSync(argvFile, "utf8");
	assert.match(argv, /BatchMode=yes box\.example -- npx -y pi-mobile@\S+ enrol/);
	const vapid = new PushStore(laptop.dir).vapid;
	assert.ok(!argv.includes(vapid.privateKey), "no push key on the command line");
	const [offer] = new OfferStore(laptop.dir).list();
	assert.ok(!argv.includes(offer.k!), "no device key on the command line");
	assert.equal(readdirSync(join(box, "pi-mobile")).includes("devices.json"), true);
});

test("the API answers other origins, the page may call your tailnet, and a phone can move every machine to a new push key", async () => {
	const { hub, phone } = await machineWithPhone("laptop");
	const base = `http://127.0.0.1:${hub.port}`;
	const pre = await fetch(`${base}/api/rpc`, {
		method: "OPTIONS",
		headers: { origin: "https://laptop.tail1.ts.net", "access-control-request-method": "POST", "access-control-request-private-network": "true" },
	});
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get("access-control-allow-origin"), "*");
	assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
	assert.equal(pre.headers.get("access-control-allow-private-network"), "true");
	assert.equal((await fetch(`${base}/api/rpc`, { method: "POST", body: "{}" })).headers.get("access-control-allow-origin"), "*");

	const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
	assert.match(csp, /connect-src 'self' https:\/\/\*\.ts\.net:\*/);

	const next = generateVapid();
	const r = await phone.rpc("push", { subscription: SUB, vapid: next });
	assert.equal(r.pushKey, next.publicKey);
	await assert.rejects(phone.rpc("push", { subscription: SUB, vapid: { publicKey: "x", privateKey: "y" } }), /invalid push key/);
});

test("offers reach a phone that is offline as one notification, then on its stream when it connects", async () => {
	const laptop = await machineWithPhone("laptop");
	await cli.add("box", { origin: "https://box.tail1.ts.net", tailnet: "laptop.tail1.ts.net", run: async (_h: string, input: any) => cli.enrol(input, tmp()) }, laptop.dir);
	const deadline = Date.now() + 5000;
	while (!laptop.pushed.some((p) => p.payload.offer) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	const note = laptop.pushed.find((p) => p.payload.offer);
	assert.match(note?.payload.body ?? "", /^Add .+ \(box\.tail1\.ts\.net\) to your sessions\? Asked on laptop\.$/);
	assert.equal(note?.payload.kind, "add", "the phone shows Add on the notification for this kind only");
	assert.equal(note?.payload.machine, "laptop-id");
});

test("enrol finds the box's HTTPS address the way its hub does: an existing serve, else a free port", async () => {
	const host = "box.tail1.ts.net";
	const fake = (serve: object) => {
		const calls: string[][] = [];
		const run = async (args: string[]) => {
			calls.push(args);
			const status = { BackendState: "Running", Self: { DNSName: `${host}.` } };
			const out = args[0] === "status" ? JSON.stringify(status) : args[1] === "status" ? JSON.stringify(serve) : "";
			return { code: 0, out, exited: Promise.resolve(0) };
		};
		return { run, calls };
	};
	const input = { from: "laptop", vapid: generateVapid(), phones: [{ id: "p", name: "phone" }] };
	const existing = fake({ TCP: { 8443: { HTTPS: true } }, Web: { [`${host}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } } } } });
	assert.equal((await cli.enrol(input, tmp(), existing.run)).origin, `https://${host}:8443`);
	const busy = fake({ TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
	assert.equal((await cli.enrol(input, tmp(), busy.run)).origin, `https://${host}:8443`);
	assert.deepEqual(busy.calls.at(-1), ["serve", "--bg", "--https=8443", "http://127.0.0.1:7878"]);
	await assert.rejects(cli.enrol(input, tmp(), async () => undefined), /Tailscale isn't running/);
});
