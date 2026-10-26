// Drives the extension through a fake pi host and a test phone speaking the real protocol.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
		// The terminal's inline dialogs: open until their `done` is called.
		custom: (factory: any) => new Promise((resolve) => factory({}, {}, {}, resolve)),
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
	const bus = new EventEmitter();
	const events = {
		emit: (c: string, d: unknown) => bus.emit(c, d),
		on: (c: string, fn: (d: any) => void) => {
			bus.on(c, fn);
			return () => bus.off(c, fn);
		},
	};
	const pi: any = {
		events,
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
	return { fire, ctx, events, sent, statuses, notes, localDialogs, thinking: () => thinking, setIdle: (v: boolean) => (idle = v) };
}

let h: ReturnType<typeof host>;
let phone: Phone;
let agent = "";

before(async () => {
	const port = await freePort();
	writeFileSync(join(stateDir(), "config.json"), JSON.stringify({ port }));
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
	// Shutting down drops the phone's drafts (their model calls and timers end with the session).
	const { PhoneDrafts } = await import("pi-speech/phone-drafts");
	const open = phone ? await call("draftStart").catch(() => undefined) : undefined;
	const dispose = PhoneDrafts.prototype.dispose;
	const left: number[] = [];
	PhoneDrafts.prototype.dispose = function (this: InstanceType<typeof PhoneDrafts>) {
		dispose.call(this);
		left.push(this.size);
	};
	phone?.close();
	try {
		await h?.fire("session_shutdown", { reason: "quit" });
	} finally {
		PhoneDrafts.prototype.dispose = dispose;
	}
	if (open) assert.deepEqual(left, [0], "session_shutdown disposes the phone's drafts");
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

test("a repeated phone action runs once and answers with the first result", async () => {
	const keyed = (m: string, p: unknown, k: string) => phone.rpc("agent", { agent, m, p, k });
	const before = h.sent.length;
	const [a, b] = await Promise.all([keyed("send", { text: "ship it" }, "k-send-0001"), keyed("send", { text: "ship it" }, "k-send-0001")]);
	assert.deepEqual(b, a);
	assert.deepEqual(await keyed("send", { text: "ship it" }, "k-send-0001"), a);
	assert.equal(h.sent.length, before + 1, "one prompt, however often it is retried");
	await keyed("send", { text: "ship it" }, "k-send-0002");
	assert.equal(h.sent.length, before + 2, "a new key is a new action");

	const answer = h.ctx.ui.confirm("Deploy?", "");
	const prompt = await phone.waitFor((e) => e.type === "prompt" && e.prompt.title === "Deploy?");
	const first = await keyed("answer", { id: prompt.prompt.id, value: true }, "k-answer-01");
	assert.equal(await answer, true);
	assert.deepEqual(await keyed("answer", { id: prompt.prompt.id, value: true }, "k-answer-01"), first, "no 'already answered' for a retry");
	await assert.rejects(call("answer", { id: prompt.prompt.id, value: true }), /already answered/);
	await phone.waitFor((e) => e.type === "prompt_end");
	phone.events = [];
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

test("ask_user_question's form reaches the phone, and the phone's answer goes back on its event channel", async () => {
	phone.events = [];
	const answers: any[] = [];
	let verdict: any = { ok: true };
	const off = h.events.on("rpiv:ask-user:answer", (a) => {
		answers.push(a);
		h.events.emit("rpiv:ask-user:answer-result", { ...verdict, requestId: a.requestId, toolCallId: a.toolCallId });
	});
	h.events.emit("rpiv:ask-user:prompt", {
		toolCallId: "call-1",
		questions: [
			{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "Relational", hasPreview: false }, { label: "SQLite", description: "Embedded", hasPreview: false }] },
			{ question: "Which extras?", header: "Extras", multiSelect: true, options: [{ label: "Auth", description: "Login", hasPreview: true }] },
		],
	});
	const { prompt } = await phone.waitFor((e) => e.type === "prompt");
	assert.equal(prompt.kind, "questionnaire");
	assert.equal(prompt.id, "ask:call-1");
	assert.equal(prompt.title, "2 questions");
	assert.deepEqual(prompt.questions[0].options[1], { label: "SQLite", description: "Embedded" });
	assert.equal(prompt.questions[1].multiSelect, true);

	verdict = { ok: false, code: "invalid_answer", reason: "question 1 is unanswered" };
	await assert.rejects(call("answer", { id: prompt.id, value: { answers: [{ questionIndex: 0, optionIndexes: [1] }] } }), /question 1 is unanswered/);
	verdict = { ok: true };
	await call("answer", { id: prompt.id, value: { answers: [{ questionIndex: 0, optionIndexes: [1], junk: 1 }, { questionIndex: 1, text: "SSO" }] } });
	assert.deepEqual(answers.at(-1), {
		toolCallId: "call-1",
		requestId: answers.at(-1).requestId,
		answers: [{ questionIndex: 0, optionIndexes: [1] }, { questionIndex: 1, text: "SSO" }],
	});
	// The prompt stays open until the extension says the questionnaire is over.
	assert.equal((await call("snapshot")).prompts.length, 1);
	h.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "call-1" });
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "remote");

	// Declined on the phone, and answered in the terminal.
	phone.events = [];
	h.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-2", questions: [{ question: "Go?", header: "Go", multiSelect: false, options: [{ label: "Yes", description: "", hasPreview: false }] }] });
	const second = (await phone.waitFor((e) => e.type === "prompt")).prompt;
	assert.equal(second.title, "Go?");
	await call("answer", { id: second.id });
	assert.equal(answers.at(-1).cancel, true);
	h.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "call-2" });
	await phone.waitFor((e) => e.type === "prompt_end");

	phone.events = [];
	h.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-3", questions: [{ question: "Go?", header: "Go", multiSelect: false, options: [] }] });
	await phone.waitFor((e) => e.type === "prompt");
	h.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "call-3" });
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "terminal");
	off();
});

test("the permission system's inline terminal dialog can be answered from the phone", async () => {
	const ask = (requestId: string) => {
		h.events.emit("permissions:ui_prompt", { requestId, source: "tool_call", surface: "bash", value: "rm -rf build", agentName: "worker", request: { surface: "bash", value: "rm -rf build", matchedPattern: "rm *" }, forwarding: null });
		// The permission system opens its dialog in the same tick it announces it.
		let done!: (v: unknown) => void;
		const decision = h.ctx.ui.custom((_t: unknown, _th: unknown, _k: unknown, d: (v: unknown) => void) => {
			done = d;
			return {};
		}, { overlay: false });
		return { decision, done: (v: unknown) => done(v) };
	};

	phone.events = [];
	const first = ask("req-1");
	const { prompt } = await phone.waitFor((e) => e.type === "prompt");
	assert.equal(prompt.kind, "permission");
	assert.equal(prompt.id, "perm:req-1");
	assert.equal(prompt.title, "Permission required");
	assert.match(prompt.message, /worker wants to use bash\nrm -rf build\nMatched rule: rm \*/);
	await assert.rejects(call("answer", { id: prompt.id, value: { action: "sudo" } }), /approve, session or deny/);
	await call("answer", { id: prompt.id, value: { action: "session" } });
	assert.deepEqual(await first.decision, { approved: true, state: "approved_for_session" });
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "remote");

	phone.events = [];
	const refused = ask("req-2");
	const second = (await phone.waitFor((e) => e.type === "prompt")).prompt;
	await call("answer", { id: second.id, value: { action: "deny", reason: " too risky " } });
	assert.deepEqual(await refused.decision, { approved: false, state: "denied_with_reason", denialReason: "too risky" });
	await phone.waitFor((e) => e.type === "prompt_end");

	phone.events = [];
	const local = ask("req-3");
	await phone.waitFor((e) => e.type === "prompt");
	local.done({ approved: true, state: "approved" });
	await local.decision;
	assert.equal((await phone.waitFor((e) => e.type === "prompt_end")).by, "terminal");
});

test("other custom terminal UI is left alone, with no prompt on the phone", async () => {
	phone.events = [];
	let done!: (v: unknown) => void;
	const panel = h.ctx.ui.custom((_t: unknown, _th: unknown, _k: unknown, d: (v: unknown) => void) => {
		done = d;
		return {};
	});
	// A permission announcement whose dialog never came (a non-terminal session) must not claim this one.
	h.events.emit("permissions:ui_prompt", { requestId: "req-x", request: {} });
	await new Promise((r) => setTimeout(r, 20));
	done("closed");
	assert.equal(await panel, "closed");
	assert.equal(phone.events.some((e) => e.type === "prompt"), false);
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

test("voice: long dictation as a draft is routed to the voice host, with a size limit per chunk", async () => {
	const s = await call("draftStart");
	assert.equal(typeof s.id, "string");
	assert.deepEqual([s.phase, s.isDraft, s.version, s.maxMs, s.warnMs], ["listening", false, 0, 600_000, 540_000]);
	// Over 4 MB of audio in one chunk is refused before any recognition.
	await assert.rejects(call("draftChunk", { id: s.id, seq: 0, audio: "A".repeat(6 * 1024 * 1024), mime: "audio/wav" }), /chunk too large/);
	await assert.rejects(call("draftChunk", { id: s.id, seq: 0 }), /no audio/);
	assert.equal((await call("draftState", { id: s.id, since: 0 })).id, s.id);
	await assert.rejects(call("draftEdit", { id: s.id, markdown: "- x" }), /still forming/);
	assert.deepEqual(await call("draftClose", { id: s.id, how: "discard" }), { ok: true, transcriptKept: false });
	await assert.rejects(call("draftFinish", { id: s.id }), /no longer open/);
});

test("terminal notifications are mirrored to the phone", async () => {
	phone.events = [];
	h.ctx.ui.notify("Build finished", "warning");
	const n = await phone.waitFor((e) => e.type === "notice");
	assert.deepEqual([n.text, n.level], ["Build finished", "warning"]);
});
