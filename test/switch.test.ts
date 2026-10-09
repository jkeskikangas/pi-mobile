// The machine-wide switch: `/remote` in one pi shares every pi; `/remote off` can hide one or all.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { freePort, until } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "remote-switch-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: piMobile } = await import("../src/index.ts");
const { closeProcessHub } = await import("../src/link.ts");
const { loadConfig, saveConfig, stateDir } = await import("../src/store.ts");

after(() => {
	closeProcessHub();
	rmSync(dir, { recursive: true, force: true });
});

function host(selectAnswer: string) {
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const statuses: (string | undefined)[] = [];
	const ui: any = {
		notify: () => {},
		setStatus: (_k: string, v?: string) => statuses.push(v),
		onTerminalInput: () => () => {},
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		select: async () => selectAnswer,
		confirm: async () => true,
		input: async () => undefined,
		custom: async () => undefined,
	};
	const ctx: any = {
		hasUI: true,
		mode: "rpc",
		cwd: "/w",
		ui,
		sessionManager: { getBranch: () => [], getSessionId: () => "s" },
		modelRegistry: {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
	};
	const pi: any = {
		on: (n: string, h: any) => handlers.set(n, [...(handlers.get(n) ?? []), h]),
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerShortcut: () => {},
		getSessionName: () => "s",
		getThinkingLevel: () => "off",
	};
	piMobile(pi);
	const fire = async (n: string, e: any = {}) => {
		for (const h of handlers.get(n) ?? []) await h({ type: n, ...e }, ctx);
	};
	return { fire, statuses, run: (args: string) => commands.get("remote").handler(args, ctx) };
}

test("a running pi joins and leaves when the machine switch flips elsewhere", async () => {
	writeFileSync(join(stateDir(), "config.json"), JSON.stringify({ port: await freePort(), expose: "local" }));
	const h = host("Only this session");
	await h.fire("session_start", { reason: "startup" });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(h.statuses.at(-1), undefined, "not shared before /remote");

	saveConfig({ ...loadConfig(), enabled: true }); // `/remote` in another terminal
	await until(() => h.statuses.at(-1) === "📱 shared", 6000);

	saveConfig({ ...loadConfig(), enabled: false }); // `/remote off` → every session, elsewhere
	await until(() => h.statuses.at(-1) === undefined, 6000);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("/remote turns the switch on; /remote off can hide just this session", async () => {
	const h = host("Only this session");
	await h.fire("session_start", { reason: "startup" });
	await h.run(""); // no paired device yet → shows the pairing code (rpc mode: as a notification)
	assert.equal(loadConfig().enabled, true);
	await until(() => h.statuses.at(-1) === "📱 shared");

	await h.run("off");
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(loadConfig().enabled, true, "other sessions stay shared");
	await new Promise((r) => setTimeout(r, 2000));
	assert.equal(h.statuses.at(-1), undefined, "the config watcher does not re-share a hidden session");

	await h.run("");
	await until(() => h.statuses.at(-1) === "📱 shared");
	await h.fire("session_shutdown", { reason: "quit" });
});
