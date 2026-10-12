// Next-prompt suggestions: pi-next-turn's `pi.events` reach the phone as `suggestion` events, the
// snapshot carries the current one, they clear when they stop applying, and a confident one goes
// into the "finished" notification. pi-mobile never imports pi-next-turn: these tests emit its events.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hub } from "../src/hub.ts";
import { HubLink } from "../src/link.ts";
import { DeviceStore, PushStore } from "../src/store.ts";
import { confident, draftSummary, finishedBody, P_READ, parsePrediction } from "../src/suggest.ts";
import { freePort, Phone, until } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "remote-suggest-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: remoteControl } = await import("../src/index.ts");
const { processHub } = await import("../src/link.ts");
const { stateDir } = await import("../src/store.ts");

// ── the pure parts ──────────────────────────────────────────────────────────────────────────────

test("a prediction is validated: at most three candidates, most likely first, p clamped, junk dropped", () => {
	assert.equal(parsePrediction(undefined), undefined);
	assert.equal(parsePrediction({ id: "x", candidates: [] }), undefined, "nothing to offer");
	assert.equal(parsePrediction({ candidates: [{ text: "a", p: 1 }] }), undefined, "needs an id");
	const s = parsePrediction({
		id: "n1",
		sessionId: "sess",
		candidates: [{ text: " b ", p: 0.2 }, { text: "a", p: 1.4 }, { text: "", p: 0.9 }, { text: "c", p: "high" }, { text: "d", p: 0.1 }, { text: "e", p: 0.05 }],
		readAhead: "bogus",
		draft: { files: 3, insertions: 12.7, deletions: -1, checks: "maybe" },
		at: 1,
	});
	assert.deepEqual(s, {
		id: "n1",
		sessionId: "sess",
		candidates: [
			{ text: "a", p: 1 },
			{ text: "b", p: 0.2 },
			{ text: "d", p: 0.1 },
		],
		readAhead: "none",
		draft: { files: 3, insertions: 12, deletions: 0 },
	});
});

test("the finished body adds 'Next: …?' only for a confident top candidate, with the draft's summary", () => {
	const s = (p: number, draft?: any) => ({ id: "n", candidates: [{ text: "run the tests.", p }], readAhead: "none" as const, ...(draft ? { draft } : {}) });
	assert.equal(P_READ, 0.7);
	assert.equal(confident(s(0.69)), undefined);
	assert.equal(finishedBody("All green.", s(0.69)), "All green.");
	assert.equal(finishedBody("", undefined), "pi is idle.");
	assert.equal(finishedBody("All green.", s(0.7)), "All green.\nNext: run the tests?");
	assert.equal(finishedBody("", s(0.9)), "Next: run the tests?");
	assert.equal(
		finishedBody("All green.", s(0.8, { files: 3, insertions: 10, deletions: 2, checks: "pass" })),
		"All green.\nNext: run the tests? Draft ready: 3 files · tests pass.",
	);
	assert.equal(draftSummary({ files: 1, insertions: 1, deletions: 0, checks: "fail" }), "1 file · tests fail");
	assert.equal(draftSummary({ files: 2, insertions: 1, deletions: 0, checks: "none" }), "2 files");
	const long = finishedBody("x".repeat(400), s(0.9)).split("\n");
	assert.equal(long[0].length, 160, "pi's reply is shortened so the suggestion stays on the lock screen");
	assert.equal(long[1], "Next: run the tests?");
});

test("the hub puts the suggestion into the push payload for the Send action", async () => {
	const port = await freePort();
	const hubDir = mkdtempSync(join(tmpdir(), "remote-suggest-hub-"));
	const sent: any[] = [];
	const push = new PushStore(hubDir);
	const SECRET = "s".repeat(43);
	const hub = new Hub({ config: { port, enabled: false }, secret: SECRET, devices: new DeviceStore(hubDir), push, sendPush: async (_s, payload) => (sent.push(payload), "sent") });
	await hub.listen();
	const info = { agent: "A", pid: 1, sessionId: "sess", name: "proj", cwd: "/tmp", status: "idle" as const };
	const link = new HubLink({ config: () => ({ port, enabled: false }), secret: SECRET, info: () => info, onRequest: () => null });
	link.start();
	try {
		await until(() => link.linked);
		const a = new Phone();
		await a.pair(hub.createPairing().links[0].url, "a");
		const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
		await a.rpc("push", { subscription: { endpoint: "https://push.example/a", keys } });
		link.send({ t: "attention", title: "proj finished", body: "Done.\nNext: ship it?", next: { id: "n1", text: "ship it", draft: "3 files · tests pass" } });
		link.send({ t: "attention", title: "proj finished", body: "Done.", next: { id: 5 } });
		await until(() => sent.length === 2);
		assert.deepEqual(sent[0].next, { id: "n1", text: "ship it", draft: "3 files · tests pass" });
		assert.equal("next" in sent[1], false, "a malformed suggestion is left out");
	} finally {
		link.stop();
		hub.close();
		rmSync(hubDir, { recursive: true, force: true });
	}
});

// ── through the extension, with pi.events ──────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => Promise<any> | any;

function host() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(d: unknown) => void>>();
	const events = {
		emit: (ch: string, d: unknown) => {
			for (const fn of [...(listeners.get(ch) ?? [])]) fn(d);
		},
		on: (ch: string, fn: (d: unknown) => void) => {
			const set = listeners.get(ch) ?? new Set();
			listeners.set(ch, set);
			set.add(fn);
			return () => set.delete(fn);
		},
		count: (ch: string) => listeners.get(ch)?.size ?? 0,
	};
	let session = "sess-1";
	const branch: any[] = [
		{ type: "message", id: "e1", timestamp: "2026-10-09T10:00:00Z", message: { role: "user", content: "fix the bug", timestamp: 1 } },
		{ type: "message", id: "e2", timestamp: "2026-10-09T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Fixed. Tests pass." }], stopReason: "stop", timestamp: 2 } },
	];
	const ui: any = {
		notify: () => {},
		setStatus: () => {},
		onTerminalInput: () => () => {},
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		custom: async () => undefined,
	};
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: "/work/project",
		ui,
		sessionManager: { getBranch: () => branch, getSessionId: () => session },
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
	};
	const pi: any = {
		events,
		on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerFlag: () => {},
		getFlag: (n: string) => n === "remote",
		registerCommand: () => {},
		registerShortcut: () => {},
		getSessionName: () => undefined,
		getThinkingLevel: () => "medium",
		getCommands: () => [],
		sendUserMessage: () => {},
	};
	remoteControl(pi);
	const fire = async (name: string, event: any = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx);
	};
	return { fire, events, setSession: (s: string) => (session = s) };
}

let h: ReturnType<typeof host>;
let phone: Phone;
let agent = "";
const attentions: any[] = [];
const call = (m: string, p: unknown = {}) => phone.rpc("agent", { agent, m, p });
const prediction = (id: string, p = 0.9, extra: object = {}) => ({
	id,
	sessionId: "sess-1",
	candidates: [
		{ text: "run the full test suite", p },
		{ text: "open a PR", p: 0.1 },
	],
	readAhead: "none",
	at: Date.now(),
	...extra,
});

before(async () => {
	const port = await freePort();
	writeFileSync(join(stateDir(), "config.json"), JSON.stringify({ port }));
	h = host();
	await h.fire("session_start", { reason: "startup" });
	await until(() => !!processHub());
	// What the bridge asks the hub to notify (the hub's own push path is covered above).
	(processHub() as any).attention = async (_agent: string, msg: any) => attentions.push(msg);
	phone = new Phone();
	await phone.pair(processHub()!.createPairing().links[0].url);
	agent = (await phone.rpc("hub")).agents[0].agent;
	await phone.stream(undefined, agent);
});

after(async () => {
	phone?.close();
	await h?.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.events.count("next-turn:prediction"), 0, "quitting unsubscribes from pi.events");
	rmSync(dir, { recursive: true, force: true });
});

/** A run that took longer than 20 s, so it notifies when it settles. */
async function longRun(): Promise<void> {
	await h.fire("agent_start");
	const now = Date.now;
	Date.now = () => now() + 25_000;
	try {
		await h.fire("agent_settled", { aborted: false });
	} finally {
		Date.now = now;
	}
}

test("without a next-turn engine, 'finished' goes out at once and unchanged", async () => {
	// First, before any next-turn event in this process: no engine is known.
	attentions.length = 0;
	await longRun();
	await until(() => attentions.length === 1, 500);
	assert.equal(attentions[0].body, "Fixed. Tests pass.");
	assert.equal(attentions[0].next, undefined);
});

test("predictions reach the phone, replace by id, and the snapshot carries the current one", async () => {
	phone.events = [];
	h.events.emit("next-turn:prediction", prediction("n1", 0.5));
	const ev = await phone.waitFor((e) => e.type === "suggestion");
	assert.deepEqual(
		{ ...ev, agent: undefined, seq: undefined, n: undefined },
		{
			type: "suggestion",
			id: "n1",
			candidates: [
				{ text: "run the full test suite", p: 0.5 },
				{ text: "open a PR", p: 0.1 },
			],
			readAhead: "none",
			agent: undefined,
			seq: undefined,
			n: undefined,
		},
	);
	h.events.emit("next-turn:prediction", prediction("n1", 0.5, { readAhead: "ready", draft: { files: 2, insertions: 5, deletions: 1, checks: "pass" } }));
	await phone.waitFor((e) => e.type === "suggestion" && e.readAhead === "ready");
	assert.equal(phone.events.some((e) => e.type === "suggestion_clear"), false, "the same id replaces, it doesn't clear");
	const snap = await call("snapshot");
	assert.equal(snap.suggestion.id, "n1");
	assert.equal(snap.suggestion.readAhead, "ready");
	assert.deepEqual(snap.suggestion.draft, { files: 2, insertions: 5, deletions: 1, checks: "pass" });
	assert.equal("session" in snap.suggestion, false);

	phone.events = [];
	h.events.emit("next-turn:prediction", { ...prediction("other"), sessionId: "another-session" });
	h.events.emit("next-turn:clear", { id: "not-this-one" });
	h.events.emit("next-turn:clear", { id: "n1" });
	assert.equal((await phone.waitFor((e) => e.type === "suggestion_clear")).id, "n1");
	assert.equal(phone.events.filter((e) => e.type.startsWith("suggestion")).length, 1, "another session's prediction and another id's clear are ignored");
	assert.equal((await call("snapshot")).suggestion, undefined);
});

test("a new run, a reset and a session change clear the suggestion", async () => {
	for (const [what, act] of [
		["agent_start", () => h.fire("agent_start")],
		["compaction", () => h.fire("session_compact")],
		[
			"/new",
			async () => {
				h.setSession("sess-2");
				await h.fire("session_start", { reason: "new" });
			},
		],
	] as const) {
		h.setSession("sess-1");
		h.events.emit("next-turn:prediction", prediction(`c-${what}`));
		await phone.waitFor((e) => e.type === "suggestion" && e.id === `c-${what}`);
		await act();
		await phone.waitFor((e) => e.type === "suggestion_clear" && e.id === `c-${what}`).catch(() => assert.fail(`${what} should clear it`));
		assert.equal((await call("snapshot")).suggestion, undefined, what);
		if (what === "agent_start") await h.fire("agent_settled", { aborted: true });
	}
	h.setSession("sess-1");
	await h.fire("session_start", { reason: "resume" });
});

test("with an engine, 'finished' waits (up to 3 s) for a confident prediction and offers it", async () => {
	h.events.emit("next-turn:ready", { version: 1 });
	attentions.length = 0;
	await longRun();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(attentions.length, 0, "held while the prediction is being made");
	h.events.emit("next-turn:prediction", prediction("p1", 0.6));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(attentions.length, 0, "an unsure prediction doesn't end the wait");
	const t = Date.now();
	h.events.emit("next-turn:prediction", prediction("p1", 0.85, { draft: { files: 3, insertions: 9, deletions: 2, checks: "pass" } }));
	await until(() => attentions.length === 1, 1000);
	assert.ok(Date.now() - t < 200, "sent as soon as a confident one arrives");
	assert.equal(attentions[0].body, "Fixed. Tests pass.\nNext: run the full test suite? Draft ready: 3 files · tests pass.");
	assert.deepEqual(attentions[0].next, { id: "p1", text: "run the full test suite", draft: "3 files · tests pass" });
});

test("with an engine but no confident prediction, 'finished' goes out after 3 s without one", async () => {
	attentions.length = 0;
	const t = Date.now();
	await longRun();
	await until(() => attentions.length === 1, 4000);
	const waited = Date.now() - t;
	assert.ok(waited >= 2900 && waited < 3800, `waited ${waited} ms`);
	assert.equal(attentions[0].body, "Fixed. Tests pass.");
	assert.equal(attentions[0].next, undefined);
});
