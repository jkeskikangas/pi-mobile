import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { extensionArgs, inHerdr, registerHerdrBlocked, spawnPi } from "../src/herdr.ts";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { freePort, Phone, until } from "./phone.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "remote-herdr-"));
	dirs.push(d);
	return d;
};

test("herdr is optional: nothing happens outside it", () => {
	assert.equal(inHerdr({}), false);
	assert.equal(inHerdr({ HERDR_ENV: "1" }), false, "needs the socket too");
	assert.equal(inHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/x.sock" }), true);
	const saved = { ...process.env };
	delete process.env.HERDR_ENV;
	const on: string[] = [];
	registerHerdrBlocked({ on: (n: string) => on.push(n) } as any);
	assert.deepEqual(on, []);
	Object.assign(process.env, saved);
});

test("pi dialogs mark the herdr pane blocked, balanced open/close", async () => {
	const saved = { ...process.env };
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/x.sock" });
	const handlers = new Map<string, (e: any, c: any) => void>();
	const emitted: any[] = [];
	registerHerdrBlocked({ on: (n: string, h: any) => handlers.set(n, h), events: { emit: (n: string, d: any) => emitted.push([n, d]) } } as any);
	const tui = { mode: "tui" };
	handlers.get("ui_prompt_start")!({ kind: "confirm", title: "Allow rm?" }, tui);
	handlers.get("ui_prompt_end")!({ kind: "confirm", title: "Allow rm?" }, tui);
	handlers.get("ui_prompt_start")!({ kind: "custom" }, tui); // overlays such as a QR panel are not questions
	handlers.get("ui_prompt_start")!({ kind: "select", title: "x" }, { mode: "rpc" }); // headless panes are not herdr's
	assert.deepEqual(emitted, [
		["herdr:blocked", { active: true, label: "Allow rm?" }],
		["herdr:blocked", { active: false, label: "Allow rm?" }],
	]);
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
});

test("a new session opens a tab in the workspace already in that folder, else a new workspace", async () => {
	const project = tmp();
	const other = tmp();
	const calls: [string, any][] = [];
	const fake = async (method: string, params: any): Promise<any> => {
		calls.push([method, params]);
		if (method === "pane.list") return { panes: [{ cwd: project, workspace_id: "w3" }] };
		if (method === "tab.create" || method === "workspace.create") return { root_pane: { pane_id: "w9:p1" } };
		return {};
	};
	const r = await spawnPi({ cwd: project, prompt: "fix the tests", spawnId: "s1" }, fake);
	assert.equal(r.paneId, "w9:p1");
	assert.deepEqual(calls[1], ["tab.create", { workspace_id: "w3", cwd: project, env: { PI_MOBILE_SPAWN: "s1" }, label: project.split("/").pop(), focus: false }]);
	const start = calls[2][1];
	assert.equal(calls[2][0], "agent.start");
	assert.equal(start.kind, "pi");
	assert.equal(start.pane_id, "w9:p1");
	assert.deepEqual(start.args.slice(-2), ["fix the tests", "--remote"], "a flag would swallow a prompt after it");

	calls.length = 0;
	await spawnPi({ cwd: other, prompt: "--help me", spawnId: "s2" }, fake);
	assert.equal(calls[1][0], "workspace.create");
	assert.equal(calls[2][1].args.at(-2), " --help me", "a prompt is never read as a pi flag");

	await assert.rejects(spawnPi({ cwd: "relative/dir", spawnId: "x" }, fake), /absolute/);
	await assert.rejects(spawnPi({ cwd: join(project, "missing"), spawnId: "x" }, fake), /not a folder/);
});

test("a pi loaded with -e passes the same extension to the sessions it starts", () => {
	const pkg = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
	assert.deepEqual(extensionArgs(["node", "pi", "-e", `${pkg}/src/index.ts`]), ["-e", `${pkg}/src/index.ts`]);
	assert.deepEqual(extensionArgs(["node", "pi", "--extension", pkg]), ["-e", pkg]);
	assert.deepEqual(extensionArgs(["node", "pi", "-e", "/elsewhere/ext.ts"]), [], "installed as a package: nothing to pass");
});

test("no lock-screen push while someone is typing at a terminal on that machine", async () => {
	const port = await freePort();
	const dir = tmp();
	const sent: string[] = [];
	const hub = new Hub({
		config: { port, expose: "local", enabled: false },
		secret: "s".repeat(43),
		devices: new DeviceStore(dir),
		push: new PushStore(dir),
		sendPush: async (_s, payload: any) => {
			sent.push(payload.title);
			return "sent";
		},
	});
	await hub.listen();
	const link = new HubLink({
		config: () => ({ port, expose: "local", enabled: false }),
		secret: "s".repeat(43),
		info: () => ({ agent: "A", pid: 1, sessionId: "s", name: "proj", cwd: "/p", status: "idle" }),
		onRequest: () => null,
	});
	link.start();
	try {
		await until(() => link.linked);
		const phone = new Phone();
		await phone.pair(hub.createPairing().links[0].url);
		await phone.rpc("push", { subscription: { endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" } } });

		link.send({ t: "attention", title: "away" });
		await until(() => sent.length === 1);
		link.send({ t: "presence" });
		link.send({ t: "attention", title: "at the desk" });
		await new Promise((r) => setTimeout(r, 150));
		assert.deepEqual(sent, ["away"]);
	} finally {
		link.stop();
		hub.close();
	}
});
