// Issue #4, end to end: a real pi (RPC mode) loads pi-mobile and a second extension that asks through
// ctx.ui.confirm/select/input. Every phone following the session sees each question card; answering on
// a phone answers pi's own dialog, and answering in the terminal closes the cards.

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { freePort, Phone, until } from "./phone.ts";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "pi-dialogs-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { Hub } = await import("../src/hub.ts");
const { linkSecret, loadConfig } = await import("../src/store.ts");

let hub: InstanceType<typeof Hub>;
let pi: ChildProcessWithoutNullStreams;
const out: any[] = [];
const phones = [new Phone(), new Phone()];
let agent = "";

const send = (msg: unknown) => pi.stdin.write(`${JSON.stringify(msg)}\n`);
const notes = () => out.filter((m) => m.type === "extension_ui_request" && m.method === "notify").map((m) => m.message);
const dialogs = (method: string) => out.filter((m) => m.type === "extension_ui_request" && m.method === method);

before(async () => {
	mkdirSync(join(dir, "pi-mobile"), { recursive: true });
	writeFileSync(join(dir, "pi-mobile", "config.json"), JSON.stringify({ port: await freePort(), enabled: true }));
	// The hub runs here so the test can make loopback pairing links; pi links to it like any second pi.
	hub = new Hub({ config: loadConfig(), secret: linkSecret() });
	await hub.listen();
	pi = spawn(process.execPath, [join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc", "--no-session", "-e", join(root, "src/index.ts"), "-e", join(root, "test/fixtures/ask-ext.ts")], {
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_MOBILE_TAILSCALE: "off" },
	});
	let buf = "";
	pi.stdout.on("data", (d) => {
		buf += d;
		let i = buf.indexOf("\n");
		while (i >= 0) {
			try {
				out.push(JSON.parse(buf.slice(0, i)));
			} catch {}
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	});
	pi.stderr.on("data", () => {});
	for (const [i, p] of phones.entries()) {
		const link = hub.createPairing().links.find((l) => l.url.startsWith("http://127.0.0.1"))!.url;
		await p.pair(link, `phone ${i + 1}`);
	}
	await until(() => {
		void phones[0].rpc("hub").then((h) => (agent = h.agents[0]?.agent ?? ""));
		return !!agent;
	}, 30_000);
	for (const p of phones) await p.stream(undefined, agent);
});

after(async () => {
	for (const p of phones) p.close();
	// pi writes into its agent dir while it shuts down: wait for it to exit before removing the dir.
	if (pi && pi.exitCode === null && pi.signalCode === null) {
		const exited = new Promise((r) => pi.once("exit", r));
		pi.kill();
		await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
	}
	hub?.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const answer = (p: Phone, id: string, value: unknown) => p.rpc("agent", { agent, m: "answer", p: { id, value } });

test("questions from another extension reach every phone; a phone's answer answers pi", async () => {
	send({ type: "prompt", message: "/ask" });

	// confirm: both phones get the card; phone 2 answers; pi's own dialog is dismissed.
	const [c1, c2] = await Promise.all(phones.map((p) => p.waitFor((e) => e.type === "prompt" && e.prompt.kind === "confirm", 10_000)));
	assert.equal(c1.prompt.title, "Deploy to staging?");
	assert.equal(c1.prompt.id, c2.prompt.id);
	await until(() => dialogs("confirm").length === 1, 5000);
	await answer(phones[1], c1.prompt.id, true);
	await until(() => notes().includes("confirm=true"), 5000);
	await phones[0].waitFor((e) => e.type === "prompt_end" && e.id === c1.prompt.id && e.by === "remote");

	// select: phone 1 answers.
	const s = await phones[0].waitFor((e) => e.type === "prompt" && e.prompt.kind === "select", 5000);
	assert.deepEqual(s.prompt.options, ["eu", "us"]);
	await phones[1].waitFor((e) => e.type === "prompt" && e.prompt.id === s.prompt.id);
	await answer(phones[0], s.prompt.id, "us");
	await until(() => notes().includes("select=us"), 5000);

	// input: answered in the terminal instead; both phones' cards close.
	const i = await phones[0].waitFor((e) => e.type === "prompt" && e.prompt.kind === "input", 5000);
	await until(() => dialogs("input").length === 1, 5000);
	send({ type: "extension_ui_response", id: dialogs("input")[0].id, value: "typed in the terminal" });
	await until(() => notes().includes("input=typed in the terminal"), 5000);
	for (const p of phones) assert.equal((await p.waitFor((e) => e.type === "prompt_end" && e.id === i.prompt.id, 5000)).by, "terminal");
});
