// Keystrokes in a pi terminal tell the hub you are at the computer (it then holds phone pushes).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { freePort, until } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "remote-presence-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: piMobile } = await import("../src/index.ts");
const { closeProcessHub, processHub } = await import("../src/link.ts");
const { stateDir } = await import("../src/store.ts");

after(() => {
	closeProcessHub();
	rmSync(dir, { recursive: true, force: true });
});

test("typing in a pi terminal marks this machine's user as present", async () => {
	writeFileSync(join(stateDir(), "config.json"), JSON.stringify({ port: await freePort(), enabled: true }));
	const handlers = new Map<string, any[]>();
	let onInput: ((data: string) => unknown) | undefined;
	let unsubscribed = 0;
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: "/w",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			onTerminalInput: (h: (data: string) => unknown) => {
				onInput = h;
				return () => unsubscribed++;
			},
		},
		sessionManager: { getBranch: () => [], getSessionId: () => "s" },
		modelRegistry: {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
	};
	const pi: any = {
		on: (n: string, h: any) => handlers.set(n, [...(handlers.get(n) ?? []), h]),
		registerFlag: () => {},
		registerShortcut: () => {},
		getFlag: () => false,
		registerCommand: () => {},
		getSessionName: () => "s",
		getThinkingLevel: () => "off",
		events: { emit: () => {}, on: () => {} },
	};
	piMobile(pi);
	const fire = async (n: string, e: any = {}) => {
		for (const h of handlers.get(n) ?? []) await h({ type: n, ...e }, ctx);
	};
	await fire("session_start", { reason: "startup" });
	await until(() => !!processHub() && ((processHub() as any).agents?.size ?? 0) === 1);
	// Typing before the link finishes its handshake must still reach the hub (it is queued until linked).
	assert.ok(onInput, "listens to terminal input");
	assert.equal((processHub() as any).lastPresence, 0);

	assert.equal(onInput!("x"), undefined, "never consumes the keystroke");
	await until(() => (processHub() as any).lastPresence > 0);

	await fire("session_shutdown", { reason: "quit" });
	assert.equal(unsubscribed, 1, "stops listening on shutdown");
});
