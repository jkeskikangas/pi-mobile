// Drives the extension through a fake pi host and a test phone speaking the real protocol.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { freePort, Phone, until } from "./phone.ts";

const dir = mkdtempSync(join(tmpdir(), "remote-ext-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: remoteControl } = await import("../src/index.ts");
const { processHub } = await import("../src/link.ts");
const { stateDir } = await import("../src/store.ts");

type Handler = (event: any, ctx: any) => Promise<any> | any;

function host() {
	const handlers = new Map<string, Handler[]>();
	const sent: any[] = [];
	const statuses: (string | undefined)[] = [];
	const notes: string[] = [];
	const localDialogs: { title: string; resolve: (v: any) => void; aborted: boolean }[] = [];
	let idle = true;
	let thinking = "medium";
	const branch: any[] = [
		{ type: "message", id: "e1", timestamp: "2026-10-09T10:00:00Z", message: { role: "user", content: "fix the bug", timestamp: 1 } },
		{
			type: "message",
			id: "e2",
			timestamp: "2026-10-09T10:00:01Z",
			message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0.25 } }, stopReason: "stop", timestamp: 2 },
		},
	];
	const model = { provider: "anthropic", id: "opus", name: "Opus", reasoning: true };
	// A terminal dialog that stays open until resolved, or dismissed through its signal.
	const dialog = (title: string, dismissed: unknown, opts?: { signal?: AbortSignal }) =>
		new Promise((resolve) => {
			const d = { title, resolve, aborted: false };
			localDialogs.push(d);
			opts?.signal?.addEventListener("abort", () => {
				d.aborted = true;
				resolve(dismissed);
			});
		});
	const ui: any = {
		notify: (m: string) => notes.push(m),
		setStatus: (_k: string, v?: string) => statuses.push(v),
		onTerminalInput: () => () => {},
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		custom: async () => undefined,
		confirm: (title: string, _m: string, opts: any) => dialog(title, false, opts),
		select: (title: string, _o: string[], opts: any) => dialog(title, undefined, opts),
		input: (title: string, _p: string, opts: any) => dialog(title, undefined, opts),
	};
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: "/work/project",
		ui,
		model,
		scopedModels: [],
		modelRegistry: {
			find: (p: string, id: string) => (p === "anthropic" && id === "sonnet" ? { provider: p, id, name: "Sonnet" } : undefined),
			getAvailable: () => [model],
		},
		sessionManager: { getBranch: () => branch, getSessionId: () => "sess-1" },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
		abort: () => sent.push({ abort: true }),
		compact: (o: any) => sent.push({ compact: o ?? {} }),
	};
	const pi: any = {
		on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerFlag: () => {},
		getFlag: (n: string) => n === "remote",
		registerCommand: () => {},
		registerShortcut: () => {},
		getSessionName: () => undefined,
		getThinkingLevel: () => thinking,
		setThinkingLevel: (l: string) => {
			thinking = l;
		},
		setModel: async (m: any) => sent.push({ model: m.id }) > 0,
		getCommands: () => [{ name: "review", description: "Review code", source: "extension" }],
		sendUserMessage: (content: any, options: any) => sent.push({ content, options }),
	};
	remoteControl(pi);
	const fire = async (name: string, event: any = {}) => {
		const results: any[] = [];
		for (const fn of handlers.get(name) ?? []) results.push(await fn({ type: name, ...event }, ctx));
		return results;
	};
	return { fire, ctx, sent, statuses, notes, localDialogs, thinking: () => thinking, setIdle: (v: boolean) => (idle = v) };
}

let h: ReturnType<typeof host>;
let phone: Phone;
let agent = "";

before(async () => {
	const port = await freePort();
	writeFileSync(join(stateDir(), "config.json"), JSON.stringify({ port, expose: "local" }));
	h = host();
	await h.fire("session_start", { reason: "startup" });
	await until(() => !!processHub() && h.statuses.at(-1) === "/remote");
	phone = new Phone();
	await phone.pair(processHub()!.createPairing().links[0].url);
	agent = (await phone.rpc("hub")).agents[0].agent;
	await phone.stream(undefined, agent);
	await until(() => h.statuses.at(-1) === "/remote · test phone");
});

after(async () => {
	phone?.close();
	await h?.fire("session_shutdown", { reason: "quit" });
	assert.equal(processHub(), undefined, "quitting pi closes the hub it hosts");
	rmSync(dir, { recursive: true, force: true });
});

const call = (m: string, p: unknown = {}) => phone.rpc("agent", { agent, m, p });

test("the phone sees the session and its transcript", async () => {
	const hub = await phone.rpc("hub");
	assert.equal(hub.agents.length, 1);
	assert.equal(hub.agents[0].name, "project", "named after the project folder");
	assert.equal(hub.agents[0].task, "fix the bug");
	assert.equal(hub.agents[0].cost, 0.25);
	const snap = await call("snapshot");
	assert.deepEqual(
		snap.items.map((i: any) => [i.k, i.id]),
		[
			["user", "e1"],
			["assistant", "e2"],
		],
	);
	assert.equal(snap.info.model.id, "opus");
	assert.equal(typeof snap.n, "number");
});

test("prompts from the phone reach pi, steering or queueing while it works", async () => {
	await call("send", { text: "add tests" });
	assert.deepEqual(h.sent.at(-1), { content: "add tests", options: { expandPromptTemplates: true } });
	assert.match(h.notes.at(-1)!, /From test phone: add tests/);

	h.setIdle(false);
	await call("send", {
		text: "also docs",
		mode: "followUp",
		images: [
			{ data: "AAAA", mimeType: "image/png" },
			{ data: "x", mimeType: "text/html" },
		],
	});
	assert.deepEqual(h.sent.at(-1), {
		content: [
			{ type: "text", text: "also docs" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
		options: { deliverAs: "followUp", expandPromptTemplates: true },
	});
	await call("send", { text: "wait, stop editing that file" });
	assert.equal(h.sent.at(-1).options.deliverAs, "steer");
	await call("send", { text: "/compact keep the API notes" });
	assert.deepEqual(h.sent.at(-1), { compact: { customInstructions: "keep the API notes" } });
	await call("abort");
	assert.deepEqual(h.sent.at(-1), { abort: true });
	h.setIdle(true);
	await assert.rejects(call("send", { text: "  " }), /empty/);
});

test("model, thinking and command lists", async () => {
	const models = await call("models");
	assert.deepEqual(models.current, { provider: "anthropic", id: "opus" });
	await call("setThinking", { level: "high" });
	assert.equal(h.thinking(), "high");
	await assert.rejects(call("setThinking", { level: "ultra" }), /unknown/);
	await call("setModel", { provider: "anthropic", id: "sonnet" });
	assert.deepEqual(h.sent.at(-1), { model: "sonnet" });
	await assert.rejects(call("setModel", { provider: "x", id: "y" }), /unknown model/);
	const cmds = await call("commands");
	assert.deepEqual(
		cmds.map((c: any) => c.name),
		["review", "compact"],
	);
});

test("streaming output and tool activity reach the phone", async () => {
	phone.events = [];
	await h.fire("agent_start");
	await h.fire("message_start", { message: { role: "assistant", content: [] } });
	const upd = (text: string, delta: string) =>
		h.fire("message_update", {
			message: { role: "assistant", content: [{ type: "text", text }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
		});
	await upd("Hel", "Hel");
	await upd("Hello", "lo");
	const start = await phone.waitFor((e) => e.type === "stream_start");
	const delta = await phone.waitFor((e) => e.type === "stream");
	assert.equal(delta.delta, "Hello", "deltas are coalesced");
	assert.equal(delta.key, start.key);

	const snap = await call("snapshot");
	assert.equal(snap.streaming.id, start.key, "a mid-stream snapshot includes the partial message");
	assert.ok(snap.n >= delta.n, "the snapshot's counter covers events already published");

	const final = {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello" },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
		],
		stopReason: "toolUse",
	};
	await h.fire("message_end", { message: final });
	const item = await phone.waitFor((e) => e.type === "item" && e.item.k === "assistant");
	assert.equal(item.replaces, start.key);
	await h.fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
	await h.fire("tool_execution_update", { toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "running…" }] } });
	await h.fire("tool_execution_start", { toolCallId: "t1/1", toolName: "read", args: {}, parentToolCallId: "t1" });
	assert.equal((await phone.waitFor((e) => e.type === "tool_update")).output, "running…");
	await h.fire("tool_execution_end", { toolCallId: "t1", toolName: "bash", isError: false });
	assert.equal((await phone.waitFor((e) => e.type === "tool_start")).title, "npm test");
	await phone.waitFor((e) => e.type === "tool_end");
	assert.equal(
		phone.events.some((e) => e.type === "tool_start" && e.id === "t1/1"),
		false,
		"nested calls stay hidden",
	);
	await h.fire("agent_settled", { aborted: false });
	await phone.waitFor((e) => e.type === "info" && e.info.status === "idle");
});

test("extension dialogs can be answered from the phone; the terminal dialog is dismissed", async () => {
	phone.events = [];
	const answer = h.ctx.ui.confirm("Allow rm -rf build?", "bash wants to run it");
	const prompt = await phone.waitFor((e) => e.type === "prompt");
	assert.equal(prompt.prompt.kind, "confirm");
	assert.equal(prompt.prompt.title, "Allow rm -rf build?");
	await phone.waitFor((e) => e.type === "info" && e.info.status === "waiting");
	const snap = await call("snapshot");
	assert.deepEqual(
		snap.prompts.map((p: any) => p.id),
		[prompt.prompt.id],
		"open prompts are part of the snapshot",
	);
	await assert.rejects(call("answer", { id: prompt.prompt.id, value: "yes" }), /yes or no/);
	await call("answer", { id: prompt.prompt.id, value: true });
	assert.equal(await answer, true);
	assert.equal(h.localDialogs.at(-1)!.aborted, true, "terminal dialog dismissed");
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "remote");
	await assert.rejects(call("answer", { id: prompt.prompt.id, value: false }), /already answered/);
});

test("answering in the terminal closes the phone's prompt; selects validate options", async () => {
	phone.events = [];
	const choice = h.ctx.ui.select("Pick", ["a", "b"]);
	const prompt = await phone.waitFor((e) => e.type === "prompt");
	assert.deepEqual(prompt.prompt.options, ["a", "b"]);
	await assert.rejects(call("answer", { id: prompt.prompt.id, value: "c" }), /not one of/);
	h.localDialogs.at(-1)!.resolve("b");
	assert.equal(await choice, "b");
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "terminal");
});

test("voice: status by ear, spoken brief, and the agent knows its user is listening", async () => {
	assert.equal((await call("voiceStatus")).speech, "Pi is idle.");
	await h.fire("agent_start");
	await h.fire("tool_execution_start", { toolCallId: "v1", toolName: "bash", args: { command: "npm test -- auth" } });
	const status = await call("voiceStatus");
	assert.match(status.speech, /^Working for a few seconds, now running the tests\./);
	assert.doesNotMatch(status.speech, /npm|auth/, "no commands or names by voice");
	await h.fire("tool_execution_end", { toolCallId: "v1", toolName: "bash", isError: false });
	await h.fire("agent_settled", { aborted: false });

	// No model reachable in this fake host: the brief falls back to the local rules.
	const b = await call("brief", { mode: "eyes-busy" });
	assert.equal(b.speech, "Done.");
	assert.equal(b.by, "heuristic");
	assert.match(b.report, /REQUEST: fix the bug/);

	const voiceNote = async () => (await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "x" })).find((r) => r?.systemPrompt)?.systemPrompt;
	assert.equal(await voiceNote(), undefined, "no voice note while nobody listens");
	await call("voiceState", { on: true, mode: "eyes-busy" });
	const note = await voiceNote();
	assert.match(note, /^BASE\n\n# Voice session/);
	assert.match(note, /cannot look at a screen/);
	await call("voiceState", { on: false });
	assert.equal(await voiceNote(), undefined);
	await assert.rejects(call("voiceSession", { sdp: "nope" }), /bad offer/);
});

test("terminal notifications are mirrored to the phone", async () => {
	phone.events = [];
	h.ctx.ui.notify("Build finished", "warning");
	const n = await phone.waitFor((e) => e.type === "notice");
	assert.deepEqual([n.text, n.level], ["Build finished", "warning"]);
});
