// One voice, many sessions: other pi sessions through herdr's CLI, driven here by a fake herdr (the
// injected runner). Name resolution and ambiguity, prompt → wait → read → brief, questions answered
// by keys, unreachable machines, and never resending a prompt blindly. No herdr, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoicePrompt } from "../src/dialogs.ts";
import {
	agentLabel,
	dialogPrompt,
	extractAnswer,
	fleetSummary,
	type HerdrAgent,
	HerdrTargets,
	herdrExec,
	keysFor,
	parseDialog,
	type RemoteEntry,
	resolveTarget,
	sessionDigest,
	toAgent,
} from "../src/herdr-targets.ts";
import type { RunDigest } from "../src/speech.ts";
import { remoteLines } from "../src/voice-mode.ts";
import { statusText, VoiceSession } from "../src/voice-session.ts";

// ── screens as pi draws them (captured from herdr agent read) ──

const RULE = "─".repeat(87);
const FOOTER = `${RULE}\n/private/tmp/voice-e2e-target (main)\n↑2 ↓34 W36k CH0.0% $0.286 3.6%/1.0M (auto)        (claude-sdk) claude-opus-5-5 • medium\n/remote`;

const SELECT_SCREEN = ` Pick a color using the pick_color tool.

   pick_color                                                                         ◌


${RULE}

 Which color should the button be?

 → red
   green
   blue

 ↑↓ navigate  enter select  escape/ctrl+c cancel

${FOOTER}`;

const CONFIRM_SCREEN = `${RULE}

 Save the color?
 This writes green to color.txt.

 → Yes
   No

 ↑↓ navigate  enter select  escape/ctrl+c cancel

${FOOTER}`;

const INPUT_SCREEN = `${RULE}

 What should the new name be?

 │ │

 enter submit  escape cancel

${FOOTER}`;

const answerScreen = (request: string, answer: string) => `[Extensions]
  herdr-agent-state.ts, pi-web-access:dist, src


 ${request}

   read   notes.txt  (2 lines)                                                                        ✓

 ${answer.split("\n").join("\n ")}

   2.6s · model 2.6s ×2 · tools 5ms


${RULE}

${FOOTER}`;

/** A dialog as pi draws it, the cursor on option `cursor`. */
const dialogScreen = (title: string, options: string[], cursor = 0, message?: string) =>
	`${RULE}\n\n ${title}\n${message ? ` ${message}\n` : ""}\n${options.map((o, i) => ` ${i === cursor ? "→" : " "} ${o}`).join("\n")}\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n\n${FOOTER}`;

/**
 * Dialogs one after another on a fake agent: arrows move the cursor (redrawn), Enter picks the option
 * and brings the next dialog (herdr's state counter moves: working, then blocked again), Esc cancels.
 */
function dialogs(a: FakeAgent, list: { title: string; options: string[]; message?: string }[]) {
	const chosen: (string | undefined)[] = [];
	const sent: string[][] = [];
	let i = 0;
	let cursor = 0;
	const draw = () => {
		const d = list[i];
		a.screen = { ...a.screen, visible: d ? dialogScreen(d.title, d.options, cursor, d.message) : "" };
	};
	const next = (choice: string | undefined) => {
		chosen.push(choice);
		i++;
		cursor = 0;
		a.raw.state_change_seq += 2;
		if (i >= list.length) a.raw.agent_status = "working";
		draw();
	};
	a.raw.agent_status = "blocked";
	draw();
	a.onKeys = (keys) => {
		sent.push(keys);
		for (const k of keys) {
			const d = list[i];
			if (!d) return;
			if (k === "down") cursor = Math.min(d.options.length - 1, cursor + 1);
			else if (k === "up") cursor = Math.max(0, cursor - 1);
			else if (k === "enter") next(d.options[cursor]);
			else if (k === "esc") next(undefined);
		}
		draw();
	};
	return { chosen, sent };
}

// ── a fake herdr ──

interface FakeAgent {
	raw: Record<string, any>;
	/** What `agent read` shows, by source. */
	screen?: { visible?: string; recent?: string };
	/** Called when a wait finds no wanted state: moves the agent along (one step). */
	step?: () => void;
	onPrompt?: (text: string) => void;
	onKeys?: (keys: string[]) => void;
}

class FakeHerdr {
	calls: string[][] = [];
	machines: { label: string; enabled?: boolean }[] = [];
	servers = new Map<string, { agents: FakeAgent[]; workspaces: any[]; down?: boolean }>();
	missing = false;
	promptFails?: "timeout" | "stalled" | "exec-timeout" | "blocked";

	server(machine = "") {
		if (!this.servers.has(machine)) this.servers.set(machine, { agents: [], workspaces: [] });
		return this.servers.get(machine)!;
	}
	add(machine: string, raw: Record<string, any>, extra: Partial<FakeAgent> = {}): FakeAgent {
		const a: FakeAgent = { raw: { agent: "pi", agent_status: "idle", state_change_seq: 1, tab_id: "w1:t1", workspace_id: "w1", ...raw }, ...extra };
		this.server(machine).agents.push(a);
		return a;
	}

	exec = async (args: string[], _timeout: number) => {
		this.calls.push(args);
		// A real herdr takes time: let the test run in between (a wait that times out comes back at once here).
		await new Promise((r) => setImmediate(r));
		if (this.missing) return { code: -1, stdout: "", stderr: "", missing: true };
		let a = [...args];
		let machine = "";
		if (a[0] === "--machine") {
			machine = a[1];
			a = a.slice(2);
			if (!this.machines.some((m) => m.label === machine)) return { code: 2, stdout: "", stderr: `error: unknown machine '${machine}'` };
			if (this.server(machine).down) return { code: 255, stdout: "", stderr: "ssh: connect to host devbox port 22: Operation timed out" };
		}
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" });
		const err = (code: string, message = code) => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message }, id: "cli" }) });
		const s = this.server(machine);
		const find = (id: string) => s.agents.find((x) => x.raw.pane_id === id || x.raw.name === id);
		const [noun, verb, target, ...rest] = a;
		if (noun === "machine" && verb === "list") return { code: 0, stdout: JSON.stringify(this.machines.map((m, i) => ({ id: `id${i}`, label: m.label, enabled: m.enabled ?? true }))), stderr: "" };
		if (noun === "workspace" && verb === "list") return ok({ workspaces: s.workspaces });
		if (noun === "tab" && verb === "list") return ok({ tabs: [] });
		if (noun !== "agent") return err("unknown");
		if (verb === "list") return ok({ agents: s.agents.map((x) => x.raw) });
		const ag = find(target);
		if (!ag) return err("agent_not_found", `agent target ${target} not found`);
		if (verb === "get") return ok({ agent: ag.raw });
		if (verb === "prompt") {
			if (ag.raw.agent_status === "blocked") return err("agent_blocked");
			if (this.promptFails === "exec-timeout") return { code: -1, stdout: "", stderr: "", timedOut: true };
			if (this.promptFails === "timeout") return err("timeout", "timed out");
			if (this.promptFails === "stalled") return err("agent_prompt_stalled");
			ag.onPrompt?.(rest[0]);
			return ok({ agent: ag.raw });
		}
		if (verb === "wait") {
			const until = rest.filter((_, i) => rest[i - 1] === "--until");
			if (!until.includes(ag.raw.agent_status)) ag.step?.();
			return until.includes(ag.raw.agent_status) ? ok({ agent: ag.raw }) : err("timeout", "timed out waiting");
		}
		if (verb === "read") {
			const source = rest[rest.indexOf("--source") + 1];
			return { code: 0, stdout: (source === "visible" ? ag.screen?.visible : ag.screen?.recent) ?? "", stderr: "" };
		}
		if (verb === "send-keys") {
			ag.onKeys?.(rest);
			return ok({});
		}
		return err("unknown");
	};

	/** Every prompt herdr was asked to submit. */
	prompts() {
		return this.calls.filter((c) => c.includes("prompt") && c.includes("agent"));
	}
}

function targets(h: FakeHerdr, opts: { inHerdr?: boolean; selfPane?: string; files?: Record<string, string> } = {}) {
	const shown: RemoteEntry[] = [];
	const announced: { kind: string; sentence: string; context?: string }[] = [];
	const asked: { prompt: VoicePrompt; answer: (v: unknown) => void }[] = [];
	const closed: string[] = [];
	const briefs: RunDigest[] = [];
	let t = 0;
	const ht = new HerdrTargets({
		exec: h.exec,
		inHerdr: opts.inHerdr ?? true,
		selfPane: opts.selfPane,
		brief: async (d) => {
			briefs.push(d);
			return `Brief: ${d.final.split("\n")[0].slice(0, 60)}`;
		},
		ask: (prompt, answer) => asked.push({ prompt, answer }),
		closePrompt: (id) => closed.push(id),
		announce: (kind, sentence, o) => announced.push({ kind, sentence, context: o?.context }),
		show: (e) => shown.push(e),
		quiet: () => false,
		readFile: (p) => opts.files?.[p],
		sleep: async () => {
			t += 500;
			await new Promise((r) => setImmediate(r));
		},
		now: () => t,
	});
	return { ht, shown, announced, asked, closed, briefs };
}

async function until(cond: () => unknown, what = "condition") {
	for (let i = 0; i < 500; i++) {
		if (cond()) return;
		await new Promise((r) => setImmediate(r));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const agent = (o: Partial<HerdrAgent>): HerdrAgent => ({ id: "w1:p1", kind: "pi", status: "idle", cwd: "/work/x", ...o });

// ── naming a session ──

test("names resolve against agent name, folder, workspace label and machine; ambiguity is reported", () => {
	const fleet = [
		agent({ id: "w7:p2", cwd: "/Users/me/work/pi-mobile", workspace: "private-agents", self: true }),
		agent({ id: "w1:p7", cwd: "/Users/me/work/treat", workspace: "treat" }),
		agent({ id: "w1:p8", kind: "claude", cwd: "/Users/me/work/treat", workspace: "treat" }),
		agent({ id: "w8:p1", name: "voicetarget", cwd: "/tmp/voice-e2e-target", workspace: "voice-e2e" }),
		agent({ id: "w2:p1", machine: "devbox", cwd: "/home/dev/work/tulka" }),
		agent({ id: "w3:p1", machine: "devbox", name: "treat", cwd: "/home/dev/work/treat" }),
		agent({ id: "w4:p1", machine: "devbox", name: "api", cwd: "/home/dev/work/api" }),
	];
	const machines = ["devbox"];
	const r = (q: string) => resolveTarget(q, fleet, machines);
	const id = (q: string) => {
		const x = r(q);
		return x.kind === "agent" ? `${x.agent.machine ?? ""}/${x.agent.id}` : x.kind;
	};
	assert.equal(id("voicetarget"), "/w8:p1");
	assert.equal(id("voice target"), "/w8:p1", "spoken words join into the name");
	assert.equal(id("talk to voice-e2e"), "/w8:p1", "the workspace label");
	assert.equal(id("the api session"), "devbox/w4:p1");
	assert.equal(id("tulka"), "devbox/w2:p1", "the folder's name");
	assert.equal(id("treat on devbox"), "devbox/w3:p1", "the machine narrows it");
	assert.equal(id("the claude in treat"), "/w1:p8", "a kind narrows it");
	assert.equal(id("back to this one"), "self");
	assert.equal(id("pi mobile"), "self", "naming this session's own project is this session");
	// "treat": a pi and a claude in the treat folder here, and a pi named treat on devbox.
	const amb = r("treat");
	assert.equal(amb.kind, "ambiguous");
	assert.deepEqual(amb.kind === "ambiguous" && amb.options.map((a) => a.id), ["w1:p7", "w1:p8", "w3:p1"]);
	assert.equal(id("the pi in treat here"), "/w1:p7", "this computer, and the kind");
	assert.equal(id("tul"), "devbox/w2:p1", "part of a name");
	// "the pi on devbox": three pis there.
	const many = r("the pi on devbox");
	assert.equal(many.kind, "ambiguous");
	assert.equal(many.kind === "ambiguous" && many.options.length, 3);
	assert.equal(r("nothing like it").kind, "none");
	assert.equal(agentLabel(fleet[6]), "api @devbox");
});

test("an ambiguous name: the voice asks which, with at most three options", async () => {
	const h = new FakeHerdr();
	h.machines = [{ label: "devbox" }];
	for (let i = 1; i <= 5; i++) h.add("devbox", { pane_id: `w${i}:p1`, cwd: `/home/dev/work/svc${i}`, name: `svc${i}` });
	const { ht } = targets(h);
	const out = await ht.switchTo("the pi on devbox");
	assert.equal(out.ambiguous, true);
	assert.equal((out.options as string[]).length, 3);
	assert.equal(out.more, 2);
	assert.match(String(out.note), /at most these three/);
	assert.equal(ht.label(), undefined, "nothing switched");
	const ok = await ht.switchTo("svc4 on devbox");
	assert.equal(ok.switched, "svc4 on devbox");
	assert.equal(ht.label(), "svc4 @devbox");
	assert.equal((await ht.switchTo("back to this one")).switched, "this session");
	assert.equal(ht.label(), undefined);
});

// ── requests ──

test("a request to another machine: prompt, wait, read its screen, one spoken sentence, a labelled written copy", async () => {
	const h = new FakeHerdr();
	h.machines = [{ label: "devbox" }];
	const request = "What is the codename in notes.txt?";
	const answer = "The codename in notes.txt is Blue Heron.\nThe release is planned for March 3.";
	const a = h.add("devbox", { pane_id: "w3:p1", name: "api", cwd: "/home/dev/work/api" });
	let ticks = 0;
	a.onPrompt = () => {
		a.raw.agent_status = "working";
		a.raw.state_change_seq++;
		a.step = () => {
			if (++ticks < 3) return;
			a.raw.agent_status = "done";
			a.raw.state_change_seq++;
			a.screen = { recent: answerScreen(request, answer) };
		};
	};
	const { ht, shown, announced, briefs } = targets(h);
	assert.equal((await ht.switchTo("talk to the pi on devbox")).switched, "api on devbox");
	const out = await ht.ask(request);
	assert.equal(out.delivered, "prompt");
	await until(() => announced.length, "the answer");
	// Arguments, never a shell line; the machine prefix on every call to it.
	assert.deepEqual(h.prompts(), [["--machine", "devbox", "agent", "prompt", "w3:p1", request]]);
	assert.ok(h.calls.some((c) => c.join(" ") === "--machine devbox agent wait w3:p1 --until idle --until done --until blocked --timeout 60000"));
	assert.ok(h.calls.some((c) => c.join(" ").startsWith("--machine devbox agent read w3:p1 --source recent-unwrapped --lines")));
	// The screen's chrome is gone: tool lines, timings, the editor, the footer.
	assert.equal(briefs[0].final, answer);
	assert.equal(briefs[0].request, request);
	assert.deepEqual(announced, [{ kind: "done", sentence: "Brief: The codename in notes.txt is Blue Heron.", context: announced[0].context }]);
	assert.match(announced[0].context!, /REPORT from api on devbox/);
	assert.deepEqual(
		shown.map((e) => [e.kind, e.target]),
		[
			["sent", "api @devbox"],
			["answer", "api @devbox"],
		],
	);
	assert.equal(shown[1].said, "Brief: The codename in notes.txt is Blue Heron.");
	assert.equal(shown[1].text, answer);
	assert.deepEqual(remoteLines(shown[1]), { head: "said", label: "api @devbox", body: [shown[1].said!, ...answer.split("\n")] });
	assert.deepEqual(remoteLines(shown[0]).head, "→");
});

test("a pi on this computer is read from its session file: the exact answer and what it changed", async () => {
	const h = new FakeHerdr();
	const file = "/s/session.jsonl";
	const a = h.add("", { pane_id: "w8:p1", name: "voicetarget", cwd: "/tmp/t", agent_session: { kind: "path", value: file } });
	const request = "Rename add to sum";
	const lines = [
		{ type: "session", id: "s0" },
		{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: request }] } },
		{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/math.ts" } }] } },
		{ type: "message", id: "m3", parentId: "m2", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [], details: { diff: "+a\n-b" } } },
		{ type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: "Renamed **add** to `sum` everywhere." }], stopReason: "stop" } },
		{ type: "custom", id: "x", parentId: "m4", customType: "timing" },
	];
	a.onPrompt = () => {
		a.raw.agent_status = "working";
		a.step = () => (a.raw.agent_status = "idle");
	};
	const { ht, briefs, announced } = targets(h, { files: { [file]: lines.map((l) => JSON.stringify(l)).join("\n") } });
	await ht.switchTo("voicetarget");
	await ht.ask(request);
	await until(() => announced.length);
	assert.equal(briefs[0].final, "Renamed **add** to `sum` everywhere.");
	assert.deepEqual(briefs[0].edits, [{ path: "src/math.ts", added: 1, removed: 1 }]);
	assert.ok(!h.calls.some((c) => c.includes("read")), "no screen scraping");
	// A file that lags behind (another request's run) is not trusted.
	assert.equal(sessionDigest(lines.map((l) => JSON.stringify(l)).join("\n"), "something else entirely"), undefined);
});

test("a session waiting on a question gets no prompt; its question is read out and answered with keys", async () => {
	const h = new FakeHerdr();
	const a = h.add("", { pane_id: "w8:p2", name: "dialogtarget", cwd: "/tmp/t" });
	// Choosing an option brings the next question; answering that one ends it.
	const { chosen, sent: keys } = dialogs(a, [
		{ title: "Which color should the button be?", options: ["red", "green", "blue"] },
		{ title: "Save the color?", message: "This writes green to color.txt.", options: ["Yes", "No"] },
	]);
	const { ht, asked, closed } = targets(h);
	const sw = await ht.switchTo("dialogtarget");
	assert.match(String(sw.status), /waiting on a question/);
	const out = await ht.ask("also do the other thing");
	assert.equal(out.delivered, false);
	assert.match(String(out.note), /waiting on a question/);
	assert.equal(h.prompts().length, 0, "never typed into a dialog");
	await until(() => asked.length);
	assert.deepEqual(asked[0].prompt, {
		id: asked[0].prompt.id,
		kind: "select",
		title: "Dialogtarget asks: Which color should the button be?",
		message: undefined,
		options: ["red", "green", "blue"],
	});
	asked[0].answer("green");
	await until(() => asked.length === 2, "the next question");
	// The arrows first; Enter only after a fresh read shows the cursor on the chosen option.
	assert.deepEqual(keys.slice(0, 2), [["down"], ["enter"]]);
	assert.deepEqual(chosen, ["green"]);
	assert.ok(closed.includes(asked[0].prompt.id), "the answered question is closed");
	assert.equal(asked[1].prompt.kind, "confirm");
	assert.equal(asked[1].prompt.message, "This writes green to color.txt.");
	asked[1].answer(false);
	await until(() => chosen.length === 2);
	assert.deepEqual(keys.slice(2), [["down"], ["enter"]]);
	assert.deepEqual(chosen, ["green", "No"]);
	await until(() => closed.includes(asked[1].prompt.id));
	ht.close();
});

test("two dialogs in a row with the same text: an answer meant for the first is not given to the second", async () => {
	const h = new FakeHerdr();
	const a = h.add("", { pane_id: "w8:p3", name: "twice", cwd: "/tmp/t" });
	const same = { title: "Run the migration?", options: ["Yes", "No"] };
	const { chosen } = dialogs(a, [same, same]);
	const { ht, asked, announced } = targets(h);
	await ht.switchTo("twice");
	await until(() => asked.length, "the question");
	// Answered on its own screen meanwhile: the same question is up again, herdr's counter moved.
	a.onKeys!(["enter"]);
	const calls = h.calls.length;
	asked[0].answer(false);
	await until(() => announced.some((x) => /changed; nothing was answered/.test(x.sentence)), "the refusal");
	assert.ok(!h.calls.slice(calls).some((c) => c.includes("send-keys")), "no keys for the second dialog");
	assert.deepEqual(chosen, ["Yes"]);
	// The second one is asked as a new question, and that answer goes through.
	await until(() => asked.length === 2, "asked again");
	assert.notEqual(asked[1].prompt.id, asked[0].prompt.id);
	asked[1].answer(false);
	await until(() => chosen.length === 2);
	assert.deepEqual(chosen, ["Yes", "No"]);
	ht.close();
});

test("arrows that did not land on the option: Enter is not sent", async () => {
	const h = new FakeHerdr();
	const a = h.add("", { pane_id: "w8:p4", name: "stuck", cwd: "/tmp/t" });
	const { sent } = dialogs(a, [{ title: "Which color should the button be?", options: ["red", "green", "blue"] }]);
	const move = a.onKeys!;
	a.onKeys = (k) => (k.includes("enter") ? move(k) : void sent.push(k)); // the arrows are lost
	const { ht, asked, announced } = targets(h);
	await ht.switchTo("stuck");
	await until(() => asked.length);
	asked[0].answer("blue");
	await until(() => announced.some((x) => /couldn't confirm the choice/.test(x.sentence)), "the refusal");
	assert.deepEqual(sent, [["down", "down"]], "never Enter on the wrong option");
	ht.close();
});

test("a dialog whose long options wrap is not answered with keys", () => {
	const long = `Rewrite the whole authentication module to use the new session store and migrate every ${"x".repeat(30)}`;
	const wrapped = dialogScreen("Which plan?", [long.slice(0, 84), long.slice(84), "Keep it as it is"]);
	assert.equal(parseDialog(wrapped), undefined, "a line as wide as the screen: wrapped");
	const numbered = dialogScreen("Which plan?", ["1. Rewrite the module and", "migrate the store", "2. Keep it"]);
	assert.equal(parseDialog(numbered), undefined, "an unnumbered line among numbered options: wrapped");
	assert.deepEqual(parseDialog(dialogScreen("Which plan?", ["1. Rewrite it", "2. Keep it"]))?.options, ["Rewrite it", "Keep it"]);
});

test("answering a question that changed on its screen sends nothing; free-text questions need the screen", async () => {
	const h = new FakeHerdr();
	const a = h.add("", { pane_id: "w8:p2", name: "d", cwd: "/tmp/t", agent_status: "blocked" }, { screen: { visible: SELECT_SCREEN } });
	const { ht, asked, announced } = targets(h);
	await ht.switchTo("d");
	await until(() => asked.length);
	a.screen!.visible = CONFIRM_SCREEN; // answered on its own screen meanwhile
	asked[0].answer("blue");
	await until(() => announced.some((x) => /changed; nothing was answered/.test(x.sentence)));
	assert.ok(!h.calls.some((c) => c.includes("send-keys")));
	ht.close();
	// A free-text question cannot be mapped to keys.
	assert.equal(parseDialog(INPUT_SCREEN), undefined);
	const g = new FakeHerdr();
	g.add("", { pane_id: "w9:p1", name: "e", cwd: "/tmp/e", agent_status: "blocked" }, { screen: { visible: INPUT_SCREEN } });
	const t2 = targets(g);
	await t2.ht.switchTo("e");
	await until(() => t2.announced.length);
	assert.equal(t2.announced[0].sentence, "E is waiting on a question that needs the screen.");
	assert.equal(t2.asked.length, 0);
	t2.ht.close();
});

test("dialogs from the screen: options, cursor, keys from where the cursor is", () => {
	const d = parseDialog(SELECT_SCREEN)!;
	assert.deepEqual([d.title, d.message, d.options, d.cursor], ["Which color should the button be?", undefined, ["red", "green", "blue"], 0]);
	assert.deepEqual(keysFor(d, "blue"), ["down", "down", "enter"]);
	assert.deepEqual(keysFor({ ...d, cursor: 2 }, "red"), ["up", "up", "enter"]);
	assert.deepEqual(keysFor(d, undefined), ["esc"]);
	assert.equal(keysFor(d, "purple"), undefined);
	const c = parseDialog(CONFIRM_SCREEN)!;
	assert.deepEqual(dialogPrompt(c, "Api on devbox", "q"), { id: "q", kind: "confirm", title: "Api on devbox asks: Save the color?", message: "This writes green to color.txt." });
	assert.deepEqual(keysFor(c, true), ["enter"]);
	assert.deepEqual(keysFor(c, false), ["down", "enter"]);
	assert.notEqual(d.signature, c.signature);
});

test("pi's answer from its screen: after the request's echo, without tool lines, timings, the editor or the footer", () => {
	const s = answerScreen("What is the codename in notes.txt? Answer in one short paragraph.", "The codename in notes.txt is Blue Heron.");
	assert.equal(extractAnswer(s, "What is the codename in notes.txt? Answer in one short paragraph."), "The codename in notes.txt is Blue Heron.");
	// A wrapped echo of a long request.
	const long = "Please look at the release notes and tell me which date the release is planned for, briefly";
	const wrapped = `${RULE.slice(0, 0)} Please look at the release notes and tell me which date the\n release is planned for, briefly\n\n The third of March.\n\n${RULE}\n\n${FOOTER}`;
	assert.equal(extractAnswer(wrapped, long), "The third of March.");
});

test("a newer request while the last one is still followed gets its own answer, not the previous one", async () => {
	const h = new FakeHerdr();
	const a = h.add("", { pane_id: "w5:p1", name: "svc", cwd: "/work/svc" });
	const run = (request: string, answer: string) => {
		a.raw.agent_status = "working";
		a.raw.state_change_seq++;
		let ticks = 0;
		a.step = () => {
			if (++ticks < 2) return;
			a.raw.agent_status = "done";
			a.raw.state_change_seq++;
			a.screen = { recent: answerScreen(request, answer) };
		};
	};
	let promptB = false;
	a.onPrompt = (text) => {
		if (text.startsWith("first")) run("first question", "The first answer.");
		else promptB = true; // the second starts later (below)
	};
	const announced: string[] = [];
	const digests: RunDigest[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let t = 0;
	const ht = new HerdrTargets({
		exec: h.exec,
		inHerdr: true,
		brief: async (d) => {
			digests.push(d);
			if (digests.length === 1) await gate; // the first answer is still being briefed
			return d.final;
		},
		ask: () => {},
		closePrompt: () => {},
		announce: (_k, s) => announced.push(s),
		show: () => {},
		quiet: () => false,
		sleep: async () => {
			t += 500;
			await new Promise((r) => setImmediate(r));
		},
		now: () => t,
	});
	await ht.switchTo("svc");
	assert.equal((await ht.ask("first question")).delivered, "prompt");
	await until(() => digests.length === 1, "the first answer being briefed");
	// The second request arrives while the first answer is briefed; the agent is idle from the first run.
	assert.equal((await ht.ask("second question")).delivered, "prompt");
	release();
	await until(() => announced.length === 1, "the first answer");
	assert.equal(announced[0], "The first answer.");
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
	assert.equal(announced.length, 1, "the idle state from the first run is not the second's answer");
	assert.ok(promptB);
	run("second question", "The second answer.");
	await until(() => announced.length === 2, "the second answer");
	assert.equal(announced[1], "The second answer.");
	assert.equal(digests[1].request, "second question");
	ht.close();
});

test("prompt text goes verbatim: a leading dash, several lines (one argument, never a shell)", async () => {
	const h = new FakeHerdr();
	h.add("", { pane_id: "w6:p1", name: "cli", cwd: "/work/cli" });
	const { ht } = targets(h);
	await ht.switchTo("cli");
	await ht.ask("-n is the dry-run flag, document it");
	await ht.ask("--help output: update it\nand the README");
	assert.deepEqual(h.prompts(), [
		["agent", "prompt", "w6:p1", "-n is the dry-run flag, document it"],
		["agent", "prompt", "w6:p1", "--help output: update it\nand the README"],
	]);
	ht.close();
});

test("closing the voice kills herdr commands still running (a long agent wait)", async () => {
	const signals: (AbortSignal | undefined)[] = [];
	const h = new FakeHerdr();
	const exec = h.exec;
	const { ht } = targets(h);
	(ht as any).client.exec = (args: string[], ms: number, signal?: AbortSignal) => {
		signals.push(signal);
		return exec(args, ms);
	};
	await ht.list();
	assert.ok(signals.length && signals.every((s) => s && !s.aborted));
	ht.close();
	assert.ok(signals.every((s) => s!.aborted));
	// The real runner: an aborted command is killed at once.
	const ctrl = new AbortController();
	const t0 = Date.now();
	const running = herdrExec("/bin/sleep")(["5"], 10_000, ctrl.signal);
	setTimeout(() => ctrl.abort(), 50);
	const r = await running;
	assert.equal(r.aborted, true);
	assert.ok(Date.now() - t0 < 2000);
});

// ── robustness ──

test("a prompt that timed out is never resent: the voice says it may have arrived", async () => {
	for (const fail of ["exec-timeout", "timeout", "stalled"] as const) {
		const h = new FakeHerdr();
		h.machines = [{ label: "devbox" }];
		const a = h.add("devbox", { pane_id: "w3:p1", name: "api", cwd: "/home/dev/api" });
		a.step = () => {
			a.raw.agent_status = "done";
			a.raw.state_change_seq = 9;
			a.screen = { recent: answerScreen("deploy the docs", "Docs deployed.") };
		};
		h.promptFails = fail;
		const { ht, shown, announced } = targets(h);
		await ht.switchTo("api");
		const out = await ht.ask("deploy the docs");
		assert.equal(out.delivered, "unconfirmed", fail);
		assert.match(String(out.note), /not resent/);
		assert.match(shown[0].text, /not confirmed; not resent/);
		// Followed, and read before anything else: the answer shows whether it arrived.
		await until(() => announced.length, `${fail}: the follow-up`);
		assert.equal(h.prompts().length, 1, `${fail}: exactly one prompt`);
	}
});

test("an unreachable machine: listed as such, said so, and nothing is sent", async () => {
	const h = new FakeHerdr();
	h.machines = [{ label: "devbox" }];
	h.add("", { pane_id: "w1:p1", cwd: "/work/web", agent_status: "working" });
	h.add("devbox", { pane_id: "w3:p1", name: "api", cwd: "/home/dev/api" });
	const { ht } = targets(h);
	assert.equal((await ht.switchTo("api on devbox")).switched, "api on devbox");
	h.server("devbox").down = true;
	const out = await ht.ask("run the tests");
	assert.equal(out.delivered, false);
	assert.match(String(out.error), /devbox is unreachable right now; nothing was sent/);
	assert.equal(h.prompts().length, 0);
	assert.match(await ht.status(), /can't reach api on devbox/);
	const list = await ht.list();
	assert.deepEqual(list.unreachable, ["devbox"]);
	assert.equal(list.summary, "Nothing needs you. Working: web. devbox didn't answer.");
	const sw = await ht.switchTo("the pi on devbox");
	assert.match(String(sw.error), /devbox is unreachable/);
});

test("outside herdr, or without the herdr command, other sessions are off and the voice says so once", async () => {
	const outside = targets(new FakeHerdr(), { inHerdr: false });
	assert.match(String((await outside.ht.list()).error), /not running inside herdr\. Tell the developer once/);
	assert.match(String((await outside.ht.switchTo("api")).error), /already told/);
	const h = new FakeHerdr();
	h.missing = true;
	const missing = targets(h);
	assert.match(String((await missing.ht.switchTo("api")).error), /herdr command is not installed\. Tell the developer once/);
});

test("anything need me: states by project in a sentence or two, this session left out", () => {
	const fleet = [
		agent({ id: "1", cwd: "/w/pi-mobile", self: true, status: "working" }),
		agent({ id: "2", cwd: "/w/api", machine: "devbox", status: "blocked" }),
		agent({ id: "3", cwd: "/w/web", status: "blocked" }),
		agent({ id: "4", cwd: "/w/treat", status: "working" }),
		agent({ id: "5", cwd: "/w/treat", status: "working" }),
		agent({ id: "6", cwd: "/w/docs", status: "done" }),
		agent({ id: "7", cwd: "/w/x", status: "idle" }),
		agent({ id: "8", cwd: "/w/y", status: "idle", machine: "devbox" }),
	];
	assert.equal(fleetSummary(fleet), "Two need you: api on devbox and web. Working: treat (two); finished: docs; two idle.");
	assert.equal(fleetSummary(fleet, [], "devbox"), "One needs you: api on devbox. One idle.");
	assert.equal(fleetSummary([fleet[0]]), "There are no other sessions.");
	const raw = toAgent({ pane_id: "w1:p1", agent: "pi", agent_status: "weird", cwd: "/a" });
	assert.equal(raw?.status, "unknown");
	assert.equal(toAgent({ nope: true }), undefined);
});

test("garbage from herdr is an error, not a crash", async () => {
	const h = new FakeHerdr();
	const exec = async () => ({ code: 0, stdout: "not json", stderr: "" });
	const t = targets(h);
	(t.ht as any).client.exec = exec;
	const out = await t.ht.list();
	assert.match(String(out.error), /unreadable output/);
});

// ── the voice while switched ──

test("while switched: the status line names the target; requests, parked lines, status and stop go there", async () => {
	const sent: any[] = [];
	const calls: string[] = [];
	let target: string | undefined = "api @devbox";
	const pi = {
		editor: "",
		messages: [] as string[],
		aborted: 0,
		isIdle: () => true,
		send(t: string) {
			this.messages.push(t);
		},
		abort() {
			this.aborted++;
		},
		getEditorText() {
			return this.editor;
		},
		setEditorText(t: string) {
			this.editor = t;
		},
		notify() {},
		status: () => "pi is idle.",
		details: async () => "",
		parkHint() {},
	};
	const s = new VoiceSession({
		send: (ev) => sent.push(ev),
		player: { write() {}, flush() {} },
		earcon: () => Buffer.alloc(0),
		pi,
		targets: {
			label: () => target,
			ask: async (text) => {
				calls.push(`ask:${text}`);
				return text.includes("busy") ? { delivered: false, note: "waiting on a question" } : { delivered: "prompt" };
			},
			list: async (m) => ({ summary: `list ${m ?? "all"}` }),
			switchTo: async (n) => {
				calls.push(`switch:${n}`);
				target = /this one/.test(n) ? undefined : "treat";
				return { switched: n };
			},
			status: async () => "Api on devbox is working.",
			stop: async () => {
				calls.push("stop");
				return { stopped: true };
			},
		},
	});
	s.open();
	const outputs = () => sent.filter((e) => e.item?.type === "function_call_output").map((e) => JSON.parse(e.item.output));
	const call = async (name: string, args: Record<string, unknown>) => {
		s.onRealtime({ type: "response.function_call_arguments.done", call_id: `c${Math.random()}`, name, arguments: JSON.stringify(args) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
		return outputs().at(-1);
	};
	assert.equal(statusText(s.status()), "voice → api @devbox: listening");
	assert.deepEqual(await call("ask_pi", { request: "run the tests" }), { delivered: "prompt" });
	assert.deepEqual(pi.messages, [], "this pi got nothing");
	assert.equal((await call("pi_status", {})).speech, "Api on devbox is working.");
	// A parked request goes there when sent.
	s.park("rename it to the following");
	assert.equal(statusText(s.status()), "voice → api @devbox: listening · parked: finish typing, Enter sends to api @devbox");
	pi.editor += "sumPlusOne";
	s.onRealtime({ type: "input_audio_buffer.speech_started" });
	s.onRealtime({ type: "input_audio_buffer.speech_stopped" });
	s.onRealtime({ type: "input_audio_buffer.committed", item_id: "i1" });
	s.onRealtime({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Send it." });
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(calls.slice(-1), ["ask:rename it to the following: sumPlusOne"]);
	assert.equal(pi.editor, "");
	assert.deepEqual(pi.messages, []);
	// Not sent there: the voice is told to say why.
	await s.sendRemote("busy one");
	assert.ok(sent.some((e) => e.item?.content?.[0]?.text?.includes("was not sent: waiting on a question")));
	// "Stop pi" stops that session, never this pi.
	s.onRealtime({ type: "input_audio_buffer.committed", item_id: "i2" });
	s.onRealtime({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "Stop pi." });
	assert.equal(calls.at(-1), "stop");
	assert.deepEqual(await call("stop_pi", {}), { stopped: true, note: "stopping api @devbox" }, "the model's call reports it, no second stop");
	assert.equal(calls.filter((c) => c === "stop").length, 1);
	assert.equal(pi.aborted, 0);
	// list_sessions and switching back.
	assert.deepEqual(await call("list_sessions", { machine: "devbox" }), { summary: "list devbox" });
	await call("switch_session", { name: "this one" });
	assert.equal(statusText(s.status()), "voice: listening");
	await call("ask_pi", { request: "what's in the readme" });
	assert.deepEqual(pi.messages, ["what's in the readme"]);
	s.close();
});
