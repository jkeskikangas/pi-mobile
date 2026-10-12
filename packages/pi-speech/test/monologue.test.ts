// In voice mode, recognising a monologue (designs/voice-modalities.md): the voice model's `draft`
// tool, the local 20 s backstop, no replies while drafting (create_response off and back), "no, just
// answer that", closing by phrase and by the pause question, the read-back and the clarification
// loop, and sending to this pi or another session. Also the three fixes that came with it: dialog
// questions without doubled punctuation, the transcription language, and lines said verbatim.

import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf, systemLanguage } from "../src/config.ts";
import { sentence, speakPrompt } from "../src/dialogs.ts";
import { Draft } from "../src/draft.ts";
import { HerdrTargets } from "../src/herdr-targets.ts";
import {
	BACKSTOP_MS,
	CLOSE_PAUSE_MS,
	cleanReadBack,
	type DraftFacts,
	draftFacts,
	EVERYTHING,
	everythingAnswer,
	heuristicReadBack,
	NO_MORE_QUESTIONS,
	type OpenDraft,
	parseDraftCommand,
	readBackPrompt,
	spokenQuestion,
	splitClosing,
	STREAK_GAP_MS,
} from "../src/monologue.ts";
import { realtimeSession, sayInstructions, TERMINAL_TOOLS, voiceInstructions } from "../src/realtime.ts";
import { voiceHints } from "../src/voice-draft.ts";
import { transcriptionLanguage } from "../src/voice-mode.ts";
import { statusText, type VoicePorts } from "../src/voice-session.ts";
import { harness } from "./voice-harness.ts";

/** A turn detection unlike the terminal's, so restoring it is visible. */
const TD = { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true };
const tick = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A draft on screen, as the monologue sees it; `send` goes through the session like the real view's Enter. */
function fakeDraft() {
	let events!: { finish(): void; closed(how: "sent" | "kept"): void };
	const f = {
		opened: [] as OpenDraft[],
		contents: [] as string[],
		changes: [] as string[],
		asking: [] as (string | undefined)[],
		finished: 0,
		discarded: 0,
		missed: 0,
		kept: 0,
		sentMarkdown: [] as string[],
		points: ["Exponential backoff on upload", "Fix the flaky upload test", "Docs need a section on offline use"],
		questions: ["Should the cap apply to downloads too?", "Which error message should it show?"],
		sendDraft: (_md: string) => {},
		finishGate: Promise.resolve(),
		get events() {
			return events;
		},
	};
	const port = {
		content: (t: string) => void f.contents.push(t),
		finish: async () => {
			f.finished++;
			await f.finishGate;
		},
		change: async (s: string) => {
			f.changes.push(s);
			f.questions = f.questions.filter((q) => !s.includes(q));
		},
		facts: (): DraftFacts => ({ title: "Upload retries", points: f.points, questions: f.questions, sections: ["Requirements", "Also mentioned"] }),
		readBack: async (x: DraftFacts) => heuristicReadBack(x),
		asking: (q: string | undefined) => void f.asking.push(q),
		send: () => {
			const md = "## Requirements\n- Exponential backoff on upload";
			f.sentMarkdown.push(md);
			f.sendDraft(md);
			events.closed("sent");
		},
		keep: () => {
			f.kept++;
			events.closed("kept");
		},
		discard: () => void f.discarded++,
		missed: () => void f.missed++,
	};
	const openDraft: VoicePorts["openDraft"] = (o, e) => {
		f.opened.push(o);
		events = e;
		return port;
	};
	return { f, openDraft };
}

function drafting(extra: Partial<VoicePorts> = {}) {
	const d = fakeDraft();
	const h = harness("normal", { turnDetection: TD, openDraft: d.openDraft, ...extra });
	d.f.sendDraft = (md) => h.s.sendDraft(md);
	const updates = () => h.sent.filter((e) => e.type === "session.update" && e.session.audio).map((e) => e.session.audio.input.turn_detection);
	const creates = () => h.sent.filter((e) => e.type === "response.create");
	/** The response being asked for is generated and heard to its end. */
	const reply = () => {
		h.ev("response.created");
		h.ev("response.done", { response: { status: "completed" } });
	};
	const said = () => h.injected().filter((t) => t.startsWith("[PI] SAY"));
	return { ...h, f: d.f, updates, creates, reply, said };
}

/** Opens a draft by the voice model's tool, after one turn of composing. */
async function byIntent(h: ReturnType<typeof drafting>) {
	h.say("I want to describe the upload retry feature for the phone app.");
	h.ev("response.created");
	await h.call("draft", { shape: "spec" });
	h.ev("response.done", { response: { status: "cancelled" } });
}

// ── the intent tool ──

test("intent: the draft tool opens a draft with what was already said; a soft tone; no replies from then on", async () => {
	const h = drafting();
	await byIntent(h);
	assert.equal(h.s.mono.phase, "composing");
	assert.deepEqual(h.outputs().at(-1), { drafting: true, note: "The draft is open on their screen and collects what they say. Say nothing." });
	const o = h.f.opened[0]!;
	assert.equal(o.reason, "intent");
	assert.equal(o.shape, "spec");
	assert.equal(o.seed, "I want to describe the upload retry feature for the phone app.", "what was said before the tool call is in the draft");
	assert.ok(h.played.includes("draft"), "the soft draft tone");
	assert.ok(h.types().includes("response.cancel"), "whatever the voice was about to say is cut");
	// The server is told not to answer pauses.
	assert.deepEqual(h.updates(), [{ ...TD, create_response: false, interrupt_response: false }]);
	const before = h.creates().length;
	h.say("Uploads should retry with exponential backoff.");
	h.clock.advance(3000);
	h.say("Cap it at three retries.");
	h.clock.advance(3000);
	assert.equal(h.creates().length, before, "pauses never get a reply");
	assert.deepEqual(h.f.contents, ["Uploads should retry with exponential backoff.", "Cap it at three retries."]);
	assert.match(statusText(h.s.status()), /voice: drafting/);
	// A turn that couldn't be transcribed: said so in the view, not silently lost.
	h.ev("input_audio_buffer.speech_started");
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "f" });
	h.ev("conversation.item.input_audio_transcription.failed", { item_id: "f" });
	assert.equal(h.f.missed, 1);
	// The model's own audio can't leak in either.
	assert.equal(h.outputs().length, 1);
	// Calling it again is harmless.
	await h.call("draft", {});
	assert.equal(h.f.opened.length, 1);
	assert.ok(TERMINAL_TOOLS.some((t) => t.name === "draft"));
	assert.match(voiceInstructions("glance", "p", "", "", "terminal"), /describing a feature, listing requirements, reasoning through a design or a bug\), call draft and say nothing/);
});

test("intent: pi's news waits while the developer talks it through, and is said after the draft closes", async () => {
	const h = drafting();
	await byIntent(h);
	h.s.announce("done", "The tests pass now.");
	h.clock.advance(2000);
	assert.ok(!h.said().some((t) => t.includes("tests pass")), "silent while composing");
	assert.ok(!h.played.includes("done"));
	h.say("No, just answer that.");
	h.reply();
	h.clock.advance(2000);
	assert.ok(h.said().some((t) => t.includes("The tests pass now.")));
});

// ── the duration backstop ──

test("backstop: 20 s of continuous speech starts a draft locally, from where the speech began, nothing lost", () => {
	const h = drafting();
	const turn = (text: string, ms: number, gap = 800) => {
		const item = `i${Math.random()}`;
		h.ev("input_audio_buffer.speech_started");
		h.clock.advance(ms);
		h.ev("input_audio_buffer.speech_stopped");
		h.ev("input_audio_buffer.committed", { item_id: item });
		h.ev("conversation.item.input_audio_transcription.completed", { item_id: item, transcript: text });
		h.clock.advance(gap);
	};
	h.clock.advance(5000);
	const began = h.clock.now();
	turn("So the upload screen needs a retry.", 6000);
	turn("And the queue should survive a restart.", 7000);
	// The third stretch is still being spoken when 20 s have passed.
	h.ev("input_audio_buffer.speech_started");
	assert.equal(h.f.opened.length, 0);
	h.clock.advance(BACKSTOP_MS - (h.clock.now() - began) - 1);
	assert.equal(h.f.opened.length, 0);
	h.clock.advance(1);
	assert.equal(h.f.opened.length, 1, "decided locally, without the model");
	const o = h.f.opened[0]!;
	assert.equal(o.reason, "backstop");
	assert.equal(o.since, began, "the draft's clock starts where the monologue began");
	assert.equal(o.seed, "So the upload screen needs a retry. And the queue should survive a restart.");
	assert.ok(h.played.includes("draft"));
	// The utterance in progress lands in the draft when its words arrive; it gets no reply.
	const before = h.creates().length;
	h.clock.advance(4000);
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "x" });
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "x", transcript: "Three retries at most." });
	assert.deepEqual(h.f.contents, ["Three retries at most."]);
	assert.equal(h.creates().length, before);
	assert.deepEqual(h.updates()[0], { ...TD, create_response: false, interrupt_response: false });
});

test("backstop: a real pause, the voice answering, or a request handed to pi resets it", async () => {
	const h = drafting();
	const talk = (ms: number) => {
		h.ev("input_audio_buffer.speech_started");
		h.clock.advance(ms);
		h.ev("input_audio_buffer.speech_stopped");
	};
	// 12 s, a pause longer than a breath, 12 s: not continuous.
	talk(12_000);
	h.clock.advance(STREAK_GAP_MS + 500);
	talk(12_000);
	h.clock.advance(1000);
	assert.equal(h.f.opened.length, 0);
	// The voice said something to the end in between: an exchange, not a monologue.
	h.clock.advance(10_000);
	talk(12_000);
	h.ev("output_audio_buffer.started");
	h.ev("output_audio_buffer.stopped");
	h.clock.advance(500);
	talk(12_000);
	h.clock.advance(1000);
	assert.equal(h.f.opened.length, 0);
	// A request went to pi: what came before is done with, and is not in a later draft.
	h.clock.advance(15_000);
	h.say("What is the weather in Dublin?");
	await h.call("ask_pi", { request: "What is the weather in Dublin?" });
	h.reply();
	h.clock.advance(15_000);
	h.say("Okay so about the uploads.");
	await h.call("draft", {});
	assert.equal(h.f.opened[0]!.seed, "Okay so about the uploads.");
});

// ── undo ──

test("undo: 'no, just answer that' closes the draft and what was said becomes an ordinary request", async () => {
	const h = drafting();
	await byIntent(h);
	h.say("How long does a retry wait by default?");
	const before = h.creates().length;
	h.say("No, just answer that.");
	assert.equal(h.s.mono.active, false);
	assert.equal(h.f.discarded, 1, "the draft view closes, nothing is sent");
	assert.ok(h.played.includes("off"));
	assert.deepEqual(h.updates().at(-1), TD, "replies are back on");
	const last = h.injected().at(-1)!;
	assert.match(last, /\[PI\] The developer said "no, just answer that"/);
	assert.match(last, /"I want to describe the upload retry feature for the phone app\. How long does a retry wait by default\?"$/);
	assert.ok(!last.includes("just answer that.\""), "the undo words are not part of the request");
	assert.equal(h.creates().length, before + 1, "the voice handles it now");
	assert.equal(h.creates().at(-1).response, undefined, "an ordinary reply, not a fixed line");
	assert.deepEqual(h.pi.messages, [], "nothing went to pi behind the voice's back");
	for (const s of ["no, just answer that", "Just answer it.", "Don't make a draft.", "That's not a draft", "no draft please"]) assert.equal(parseDraftCommand(s), "undo", s);
});

// ── closing ──

test("closing by phrase: the finishing check, one spoken sentence, then the open questions one at a time", async () => {
	const h = drafting();
	await byIntent(h);
	h.say("Uploads retry three times, and the flaky test gets fixed, and docs on offline use.");
	h.say("That's it.");
	assert.equal(h.s.mono.phase === "finishing" || h.s.mono.phase === "clarifying", true);
	await tick();
	assert.equal(h.f.finished, 1);
	assert.ok(!h.f.contents.some((c) => /that's it/i.test(c)), "the closing words are not content");
	const readBack = "Got it: three things under requirements and a few asides, and two questions; it's on screen.";
	assert.equal(h.said().at(-1), `[PI] SAY: "${readBack}"`);
	// Said exactly: the response carries its own instructions.
	assert.equal(h.creates().at(-1).response.instructions, sayInstructions(readBack));
	h.reply();
	assert.equal(h.said().at(-1), '[PI] SAY: "Should the cap apply to downloads too?"');
	assert.deepEqual(h.f.asking, ["Should the cap apply to downloads too?"]);
	assert.equal(h.s.mono.phase, "clarifying");
	assert.match(statusText(h.s.status()), /draft: asking · "send it" or Enter sends/);
	// The last sentence of a longer turn closes it too, keeping what came before it.
	assert.deepEqual(splitClosing("And docs on offline use. That's it."), { content: "And docs on offline use.", close: true });
	assert.deepEqual(splitClosing("Make sure it is done right."), { content: "Make sure it is done right.", close: false });
});

test("closing by pause: after ~8 s the voice asks once, quietly, 'is that everything?'", async () => {
	const h = drafting();
	await byIntent(h);
	h.say("Uploads retry three times.");
	h.clock.advance(CLOSE_PAUSE_MS - 1);
	assert.ok(!h.said().some((t) => t.includes(EVERYTHING)));
	h.clock.advance(1);
	assert.equal(h.said().at(-1), `[PI] SAY: "${EVERYTHING}"`);
	assert.equal(h.creates().at(-1).response.instructions, sayInstructions(EVERYTHING));
	assert.ok(!h.played.slice(h.played.indexOf("draft") + 1).length, "no sound with it");
	h.reply();
	h.clock.advance(60_000);
	assert.equal(h.said().filter((t) => t.includes(EVERYTHING)).length, 1, "once");
	// "No": keep talking; nothing is added. More speech, another long pause: asked again.
	h.say("No.");
	assert.equal(h.s.mono.phase, "composing");
	assert.ok(!h.f.contents.includes("No."));
	h.say("And the error says how long until the next try.");
	h.clock.advance(CLOSE_PAUSE_MS);
	h.reply();
	assert.equal(h.said().filter((t) => t.includes(EVERYTHING)).length, 2);
	h.say("Yes.");
	await tick();
	assert.equal(h.f.finished, 1, "yes closes it");
	assert.equal(everythingAnswer("Yeah, that's it."), "yes");
	assert.equal(everythingAnswer("Yes, and also the downloads."), "content");
});

test("Enter while the draft is forming finishes it, as 'that's it' does", async () => {
	const h = drafting();
	await byIntent(h);
	h.f.events.finish();
	await tick();
	assert.equal(h.f.finished, 1);
	assert.ok(h.said().at(-1)!.startsWith('[PI] SAY: "Got it: three things'));
});

// ── clarifying ──

test("clarifying by voice: each answer edits the draft, then the next question; skip leaves one open", async () => {
	const h = drafting();
	await byIntent(h);
	const opened = h.creates().length;
	h.say("That's it.");
	await tick();
	h.reply();
	h.say("Yes, downloads too.");
	await tick();
	assert.deepEqual(h.f.changes, ['Answer to the open question "Should the cap apply to downloads too?": Yes, downloads too.']);
	h.reply();
	assert.equal(h.said().at(-1), '[PI] SAY: "Which error message should it show?"');
	assert.equal(h.s.mono.question, "Which error message should it show?");
	h.say("Skip.");
	await tick();
	assert.equal(h.f.changes.length, 1, "skipped: no edit");
	h.reply();
	assert.equal(h.said().at(-1), `[PI] SAY: "${NO_MORE_QUESTIONS}"`);
	assert.equal(h.s.mono.phase, "ready");
	assert.equal(h.f.asking.at(-1), undefined);
	// Said while ready: a change to the draft (and "yes" or "that's it" are nothing to change).
	h.say("That's it.");
	h.say("Drop the point about docs.");
	await tick();
	assert.deepEqual(h.f.changes.at(-1), "Drop the point about docs.");
	assert.equal(h.f.changes.length, 2);
	// No reply of its own anywhere in this.
	assert.ok(
		h
			.creates()
			.slice(opened)
			.every((c) => c.response?.instructions),
		"every response since the draft opened said a fixed line",
	);
});

test("an answer said while the finishing check runs waits for it; quiet: no questions, the read-back as text", async () => {
	const h = drafting();
	await byIntent(h);
	let release!: () => void;
	h.f.finishGate = new Promise<void>((r) => (release = r));
	h.say("That's it.");
	h.say("Drop the point about docs.");
	assert.deepEqual(h.f.changes, []);
	release();
	await tick(6);
	assert.deepEqual(h.f.changes, ["Drop the point about docs."]);
	h.reply();
	assert.equal(h.said().at(-1), '[PI] SAY: "Should the cap apply to downloads too?"', "then the questions");

	const q = drafting();
	q.s.setSwitch("quiet");
	await byIntent(q);
	q.clock.advance(CLOSE_PAUSE_MS);
	assert.match(q.pi.notes.at(-1)!, /Is that everything\?/);
	q.say("That's it.");
	await tick();
	assert.match(q.pi.notes.at(-1)!, /^Got it: three things/);
	assert.equal(q.s.mono.phase, "ready");
	assert.deepEqual(q.said(), []);
});

// ── sending ──

test("'send it' (or Enter) sends the draft to pi; replies come back on; Esc keeps it in the editor", async () => {
	const h = drafting();
	await byIntent(h);
	h.say("That's it.");
	await tick();
	h.reply();
	h.say("Send it.");
	assert.deepEqual(h.pi.messages, [{ text: "## Requirements\n- Exponential backoff on upload", deliverAs: undefined }]);
	assert.ok(h.played.includes("heard"));
	assert.equal(h.s.mono.active, false);
	assert.deepEqual(h.updates().at(-1), TD);
	assert.match(h.injected().at(-1)!, /draft was sent to pi/);
	// After it, turns are ordinary again: a reply is asked for.
	h.reply();
	const before = h.creates().length;
	h.say("What is pi doing?");
	assert.equal(h.creates().length, before + 1);

	// "Send it" while still talking: finished, checked, sent; no questions.
	const g = drafting();
	await byIntent(g);
	g.say("Send it.");
	await tick();
	assert.equal(g.f.finished, 1);
	assert.equal(g.pi.messages.length, 1);
	assert.ok(!g.said().length);

	const k = drafting();
	await byIntent(k);
	k.say("Put it in the editor.");
	assert.equal(k.f.kept, 1);
	assert.equal(k.s.mono.active, false);
	assert.match(k.injected().at(-1)!, /put in their editor as text; nothing was sent/);
	assert.deepEqual(k.pi.messages, []);
});

/** herdr's CLI with one other pi ("api"), recording the prompts it was asked to submit. */
function fakeHerdr() {
	const prompts: string[][] = [];
	const agent = { pane_id: "w2:p1", name: "api", agent: "pi", agent_status: "idle", state_change_seq: 1, tab_id: "w2:t1", workspace_id: "w2", cwd: "/tmp/api" };
	const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" });
	const exec = async (args: string[]) => {
		await new Promise((r) => setImmediate(r));
		const [noun, verb, , ...rest] = args;
		if (noun === "machine") return { code: 0, stdout: "[]", stderr: "" };
		if (noun === "workspace") return ok({ workspaces: [] });
		if (noun === "tab") return ok({ tabs: [] });
		if (verb === "list") return ok({ agents: [agent] });
		if (verb === "get") return ok({ agent });
		if (verb === "prompt") {
			prompts.push(args);
			return ok({ agent });
		}
		if (verb === "read") return { code: 0, stdout: "", stderr: "" };
		void rest;
		return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }) };
	};
	return { exec, prompts };
}

test("switched to another session: the draft goes there through herdr, not to this pi", async () => {
	const herdr = fakeHerdr();
	let session!: ReturnType<typeof drafting>;
	const ht = new HerdrTargets({
		exec: herdr.exec,
		inHerdr: true,
		brief: async () => "Done.",
		ask: () => {},
		closePrompt: () => {},
		announce: () => {},
		show: () => {},
		quiet: () => false,
		sleep: async () => {
			await new Promise((r) => setImmediate(r));
		},
	});
	session = drafting({
		targets: {
			label: () => ht.label(),
			ask: (t) => ht.ask(t),
			list: (m) => ht.list(m),
			switchTo: (n) => ht.switchTo(n),
			status: () => ht.status(),
			stop: () => ht.stop(),
		},
	});
	const h = session;
	assert.equal((await h.call("switch_session", { name: "api" })).switched, "api");
	h.reply();
	await byIntent(h);
	h.say("That's it.");
	await tick();
	h.reply();
	assert.match(statusText(h.s.status()), /voice → api: draft: asking · "send it" or Enter sends to api/);
	h.say("Send it.");
	await tick(6);
	assert.deepEqual(h.pi.messages, [], "this pi got nothing");
	assert.deepEqual(herdr.prompts.at(-1), ["agent", "prompt", "w2:p1", "## Requirements\n- Exponential backoff on upload"]);
	assert.equal(voiceHints("ready", "api"), 'Say "send it" or Enter to send to api · Esc keep as text · say a change, or ↑↓ type');
	ht.close();
});

// ── pieces ──

test("draft commands: whole utterances, decided without the model", () => {
	for (const s of ["That's it.", "OK, that's all.", "I'm done", "that's everything for now", "Done."]) assert.equal(parseDraftCommand(s), "close", s);
	for (const s of ["Send it.", "OK send it", "send the draft please"]) assert.equal(parseDraftCommand(s), "send", s);
	assert.equal(parseDraftCommand("Put it in the editor."), "keep");
	assert.equal(parseDraftCommand("That's it for the retries, now the queue."), undefined);
	assert.equal(parseDraftCommand("Make sure the upload is done."), undefined);
});

test("the read-back: count, the top-level points, the number of questions; the model's sentence when usable", () => {
	const d = new Draft(`## Goal
Make uploads survive flaky networks.

## Requirements
- Exponential backoff on upload, capped at 3 retries *(You first said 5, later 3; kept 3.)*
- Fix the flaky upload test

## Open questions
1. Should the cap apply to downloads too?

## Also mentioned
- Docs need a section on offline use`);
	const f = draftFacts(d);
	assert.deepEqual(f.points, ["Exponential backoff on upload, capped at 3 retries", "Fix the flaky upload test", "Docs need a section on offline use"]);
	assert.deepEqual(f.questions, ["Should the cap apply to downloads too?"]);
	assert.deepEqual(f.sections, ["Requirements", "Also mentioned"]);
	// Long points are not cut to their first words: the sections say what it is about.
	assert.equal(heuristicReadBack(f), "Got it: three things under requirements and a few asides, and one question; it's on screen.");
	assert.equal(
		heuristicReadBack({ title: "", points: ["Retry uploads", "Fix the flaky test", "Offline docs"], questions: ["Downloads too?", "Which message?"], sections: ["Tasks"] }),
		"Got it: three things, retry uploads, fix the flaky test and offline docs, and two questions.",
	);
	assert.equal(heuristicReadBack({ title: "", points: [], questions: [], sections: [] }), "Got it; the draft is on screen.");
	assert.match(readBackPrompt(f), /THINGS \(3\):\n- Exponential backoff.*\nOPEN QUESTIONS: 1$/s);
	assert.equal(cleanReadBack('"Got it: three things, retries, the flaky test and docs, and one question"'), "Got it: three things, retries, the flaky test and docs, and one question.");
	assert.equal(cleanReadBack("word ".repeat(60)), undefined, "a paragraph is not one sentence");
	// Open questions are asked as questions.
	assert.equal(spokenQuestion("Should the cap apply to downloads too?"), "Should the cap apply to downloads too?");
	assert.equal(spokenQuestion("Whether the same retry cap should also apply to downloads."), "Open question: whether the same retry cap should also apply to downloads.");
});

// ── the three fixes ──

test("fix: spoken questions get one full stop, not doubled punctuation", () => {
	assert.equal(speakPrompt({ id: "1", kind: "confirm", title: "Save the color?", message: "It goes in the theme." }), "Save the color? It goes in the theme. Yes or no?");
	assert.equal(speakPrompt({ id: "1", kind: "confirm", title: "dialogtarget asks: Save the color?" }), "dialogtarget asks: Save the color? Yes or no?");
	assert.equal(
		speakPrompt({ id: "1", kind: "select", title: "Which color?", options: ["Red.", "Green", "Blue"] }),
		"Which color? one: Red. two: Green. There are 3 on screen.",
	);
	assert.equal(speakPrompt({ id: "1", kind: "input", title: "Name the branch" }), "Name the branch. What should I answer?");
	for (const p of ["Done!", "Really?", "Note: ", "Wait…", 'He said "go."']) assert.equal(sentence(p), p.trim());
	assert.equal(sentence("one, "), "one.");
	for (const kind of ["confirm", "select", "input"] as const)
		assert.doesNotMatch(speakPrompt({ id: "1", kind, title: "Save the color?", message: "Really?", options: ["Yes", "No"] }), /[?!.]\./);
});

test("fix: the realtime transcription gets the configured or the system language", () => {
	assert.equal(transcriptionLanguage({ locale: "fi-FI" }, () => "en"), "fi");
	assert.equal(transcriptionLanguage({}, () => "en"), "en", "the system's, so 'Green.' is not heard as Japanese");
	assert.equal(transcriptionLanguage({}, () => undefined), undefined);
	assert.equal(systemLanguage({}, "darwin", () => "en_FI"), "en");
	assert.equal(systemLanguage({ LANG: "fi_FI.UTF-8" } as any, "linux"), "fi");
	assert.equal(systemLanguage({ LANG: "C.UTF-8", LC_MESSAGES: "de_DE" } as any, "linux"), "de");
	assert.equal(languageOf("pt-BR"), "pt");
	assert.equal(languageOf(""), undefined);
	const s: any = realtimeSession({ mode: "glance", project: "p", surface: "terminal", language: "en" });
	assert.deepEqual(s.audio.input.transcription, { model: "gpt-4o-mini-transcribe", language: "en" });
	// The phone keeps what it had: the configured locale only.
	assert.deepEqual((realtimeSession({ mode: "glance", project: "p" }) as any).audio.input.transcription, { model: "gpt-4o-mini-transcribe" });
	assert.equal((realtimeSession({ mode: "glance", project: "p", language: "fi-FI" }) as any).audio.input.transcription.language, "fi");
});

test("fix: the said line is handed over verbatim: the response's own instructions carry the exact words", () => {
	const h = harness();
	h.s.announce("done", "Renamed, and the imports are updated.");
	h.clock.advance(10);
	assert.equal(h.injected().at(-1), '[PI] SAY: "Renamed, and the imports are updated."');
	const create = h.sent.filter((e) => e.type === "response.create").at(-1);
	assert.equal(create.response.tool_choice, "none", "no tool call instead of the line");
	const i = create.response.instructions as string;
	assert.match(i, /^Say exactly this, word for word, and nothing else:\n\nRenamed, and the imports are updated\.\n\n/);
	assert.match(i, /Do not rephrase, shorten, translate, explain or add anything before or after it/);
	assert.match(sayInstructions("Done.", "warm, unhurried"), /Your voice: warm, unhurried\.$/);
	// A turn's reply stays an ordinary response.
	h.ev("response.created");
	h.ev("response.done", { response: { status: "completed" } });
	h.say("What is pi doing?");
	assert.deepEqual(h.sent.filter((e) => e.type === "response.create").at(-1), { type: "response.create" });
	// The session instructions say it too.
	assert.match(voiceInstructions("glance", "p", "", "", "terminal"), /say them verbatim, word for word, as written: do not rephrase, shorten, translate or add anything/);
});
