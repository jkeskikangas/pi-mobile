import assert from "node:assert/strict";
import { test } from "node:test";
import { type CliResult, ensureServe, isPrivate, privateAddresses, serveUrl } from "../src/expose.ts";
import { Hub } from "../src/hub.ts";
import { freePort } from "./phone.ts";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal }) as any;

test("a cloud box's public address is never listened on; tailnet comes first", () => {
	const hetzner = {
		lo: [v4("127.0.0.1", true)],
		eth0: [v4("203.0.113.10"), { address: "2a01:4f8::1", family: "IPv6", internal: false } as any],
		enp7s0: [v4("10.0.0.2")],
		tailscale0: [v4("100.101.102.103")],
		docker0: [v4("172.17.0.1")],
	};
	assert.deepEqual(privateAddresses(hetzner), [
		{ ip: "100.101.102.103", label: "tailscale" },
		{ ip: "10.0.0.2", label: "lan enp7s0" },
		{ ip: "172.17.0.1", label: "lan docker0" },
	]);
});

const HOST = "mac.tail1.ts.net";
const running = { BackendState: "Running", Self: { DNSName: `${HOST}.`, TailscaleIPs: ["100.88.1.2", "fd7a::1"] } };
const served = (port: number, proxy: string) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${HOST}:${port}`]: { Handlers: { "/": { Proxy: proxy } } } } });

/** A scripted tailscale CLI: answers status calls, records serve calls. */
function fakeCli(serveStatus: unknown, onServe: (args: string[]) => Partial<CliResult> = () => ({ code: 0 })) {
	const calls: string[][] = [];
	const cli = async (args: string[]): Promise<CliResult> => {
		calls.push(args);
		const out = args[0] === "status" ? JSON.stringify(running) : args[1] === "status" ? JSON.stringify(serveStatus) : "";
		const r = { code: 0, out, exited: Promise.resolve(0), ...(args[1] === "--bg" ? onServe(args) : {}) };
		return r as CliResult;
	};
	return { cli, calls, serves: () => calls.filter((a) => a[1] === "--bg") };
}

test("serveUrl finds the HTTPS address that forwards to the hub's port", () => {
	assert.equal(serveUrl(served(443, "http://127.0.0.1:7878"), 7878), `https://${HOST}`);
	assert.equal(serveUrl(served(8443, "localhost:7878"), 7878), `https://${HOST}:8443`);
	assert.equal(serveUrl(served(443, "http://127.0.0.1:3000"), 7878), undefined, "another app's serve");
	assert.equal(serveUrl({ TCP: { 443: { HTTPS: false } }, Web: served(443, "7878").Web }, 7878), undefined, "not HTTPS");
	assert.equal(serveUrl({}, 7878), undefined);
});

test("ensureServe reuses an existing serve and never touches other serve config", async () => {
	const reuse = fakeCli(served(8443, "http://127.0.0.1:7878"));
	assert.deepEqual(await ensureServe(7878, reuse.cli, async () => false), { url: `https://${HOST}:8443` });
	assert.equal(reuse.serves().length, 0);

	// 443 serves another app, 8443 is held by a local program: pi takes 10000.
	const add = fakeCli(served(443, "http://127.0.0.1:3000"));
	const r = await ensureServe(7878, add.cli, async (_ip, p) => p === 8443);
	assert.deepEqual(r, { url: `https://${HOST}:10000` });
	assert.deepEqual(add.serves(), [["serve", "--bg", "--https=10000", "http://127.0.0.1:7878"]]);
});

test("ensureServe hands back the enable link and the address once the tailnet enables Serve", async () => {
	const link = "https://login.tailscale.com/f/serve?node=abc";
	const { cli } = fakeCli({}, () => ({ code: null, out: `Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  ${link}\n`, exited: Promise.resolve(0) }));
	const r = await ensureServe(7878, cli, async () => false);
	assert.equal(r.enable, link);
	assert.equal(await r.pending, `https://${HOST}`);
});

test("ensureServe does nothing without a running Tailscale", async () => {
	assert.deepEqual(await ensureServe(7878, async () => undefined), {});
	const stopped = async (args: string[]) => ({ code: 0, out: args[0] === "status" ? JSON.stringify({ BackendState: "Stopped" }) : "{}", exited: Promise.resolve(0) });
	assert.deepEqual(await ensureServe(7878, stopped), {});
});

test("the hub lists the Tailscale address first, unless an HTTPS address is configured", async () => {
	let enabled!: (url: string) => void;
	const port = await freePort();
	const hub = new Hub({
		config: { port, expose: "local", enabled: false },
		secret: "s".repeat(43),
		serve: async () => ({ enable: "https://login.tailscale.com/f/serve?x", pending: new Promise((r) => (enabled = r)) }),
	});
	try {
		await hub.syncServe();
		assert.equal(hub.endpoints()[0].label, "this computer");
		enabled(`https://${HOST}`);
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(hub.endpoints()[0], { label: "tailscale https", url: `https://${HOST}` });
	} finally {
		hub.close();
	}
	const own = new Hub({ config: { port, expose: "local", enabled: false, publicUrl: "https://pi.example.com" }, secret: "s".repeat(43), serve: async () => ({ url: `https://${HOST}` }) });
	await own.syncServe();
	assert.deepEqual(own.endpoints()[0], { label: "https", url: "https://pi.example.com" });
	own.close();
});

test("private ranges", () => {
	for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.42", "100.64.0.1", "100.127.255.255"]) assert.equal(isPrivate(ip), true, ip);
	for (const ip of ["203.0.113.10", "172.32.0.1", "100.63.0.1", "100.128.0.1", "8.8.8.8", "169.254.1.1"]) assert.equal(isPrivate(ip), false, ip);
});
