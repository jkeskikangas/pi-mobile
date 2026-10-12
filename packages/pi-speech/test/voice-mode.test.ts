// Terminal voice mode (/voice): the conversation state machine, barge-in, the typing gate, parking,
// output routing and the switches, the said line, pi's questions by voice, and the voice-never-knows
// rules (issue #5). No network and no audio device: a fake clock, a fake realtime channel, a fake pi.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FilePlayer, playerCommand, playerTarget } from "../src/audio-io.ts";
import { answerFor, speakPrompt } from "../src/dialogs.ts";
import { EARCONS, earconPcm } from "../src/earcons.ts";
import { micInputArgs } from "../src/mic.ts";
import { isParkedText, PARK_MARK, parkedMessage, parkLine, pointsAhead, unmark } from "../src/park.ts";
import { realtimeSession, TERMINAL_TOOLS, VOICE_TOOLS, voiceInstructions } from "../src/realtime.ts";
import { Framer, RtpFramer } from "../src/rtc.ts";
import { BRIEF_SYSTEM, heuristicBrief, runDigest, terminalVoiceNote } from "../src/speech.ts";
import { TypingGate } from "../src/typing-gate.ts";
import { answerOutput, isFinalAnswer, registerVoiceMode, SAID, voiceShortcut } from "../src/voice-mode.ts";
import { isBackchannel, parseTerminalCommand, route, statusText, TICK_MS, TRANSCRIPT_WAIT_MS, UNCONFIRMED_MS, VoiceSession } from "../src/voice-session.ts";
import { FakeClock, harness, LOUD } from "./voice-harness.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import { ALSO_NOT_DRAFTED } from "../src/draft-session.ts";
import { VoiceDraft } from "../src/voice-draft.ts";

// Voice mode's config and state live in a throwaway directory, never the developer's.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-speech-agent-"));

// ── session state machine ──

test("a response being generated and the model being heard are tracked separately", () => {
	const h = harness();
	h.ev("response.created");
	assert.equal(h.s.responseActive, true);
	assert.equal(h.s.modelSpeaking, false);
	h.ev("output_audio_buffer.started");
	h.s.onAudio(LOUD);
	assert.deepEqual(h.played, ["audio"]);
	assert.equal(h.s.status().state, "speaking");
	// Generation ends long before the audio does.
	h.ev("response.done", { response: { status: "completed" } });
	assert.equal(h.s.responseActive, false);
	assert.equal(h.s.modelSpeaking, true);
	h.ev("output_audio_buffer.stopped");
	assert.equal(h.s.modelSpeaking, false);
	assert.equal(h.s.status().state, "listening");
});

test("barge-in: the player is killed at once; response.cancel only while a response is active; never output_audio_buffer.clear", () => {
	const h = harness();
	// Speaking after generation finished: kill the audio, nothing to cancel.
	h.ev("response.created");
	h.ev("output_audio_buffer.started");
	h.s.onAudio(LOUD);
	h.ev("response.done", { response: { status: "completed" } });
	h.ev("input_audio_buffer.speech_started");
	assert.equal(h.flushes(), 1);
	assert.ok(!h.types().includes("response.cancel"), "no active response to cancel");
	// Audio still arriving from the interrupted reply is not played.
	h.s.onAudio(LOUD);
	assert.deepEqual(h.played, ["audio"]);
	h.ev("output_audio_buffer.cleared");
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "a" });
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "a", transcript: "How long will it take?" });
	// Speaking while the reply is still generated: cancel it.
	h.ev("response.created");
	h.ev("output_audio_buffer.started");
	h.s.onAudio(LOUD);
	h.ev("input_audio_buffer.speech_started");
	assert.equal(h.flushes(), 2);
	assert.equal(h.types().filter((t) => t === "response.cancel").length, 1);
	assert.ok(!h.types().includes("output_audio_buffer.clear"), "the server clears its own buffer on speech_started");
});

test("a turn's reply is asked for at once but heard only after the words are judged", () => {
	const h = harness();
	h.ev("input_audio_buffer.speech_started");
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "t1" });
	assert.equal(h.types().filter((t) => t === "response.create").length, 1, "no waiting for the transcript to ask");
	h.ev("response.created");
	h.ev("output_audio_buffer.started");
	h.s.onAudio(LOUD);
	assert.deepEqual(h.played, [], "held until the transcript");
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "t1", transcript: "What did you change?" });
	assert.deepEqual(h.played, ["audio"]);
	h.s.onAudio(LOUD);
	assert.deepEqual(h.played, ["audio", "audio"]);
	// Without a transcript in time, the reply plays anyway.
	const g = harness();
	g.ev("input_audio_buffer.committed", { item_id: "t2" });
	g.ev("response.created");
	g.ev("output_audio_buffer.started");
	g.s.onAudio(LOUD);
	assert.deepEqual(g.played, []);
	g.clock.advance(TRANSCRIPT_WAIT_MS);
	assert.deepEqual(g.played, ["audio"]);
});

test("interrupting the voice never stops pi; 'stop pi' and 'cancel that' do", () => {
	const h = harness();
	h.pi.idle = false;
	h.s.setPiBusy(true);
	for (const words of ["Stop.", "stop talking", "shush", "be quiet"]) {
		h.say(words);
		assert.equal(h.pi.aborted, 0, words);
	}
	h.say("Stop pi.");
	assert.equal(h.pi.aborted, 1);
	h.say("Cancel that.");
	assert.equal(h.pi.aborted, 2);
	assert.equal(parseTerminalCommand("okay, stop"), "stopTalking");
	assert.equal(parseTerminalCommand("stop the work"), "stopPi");
	assert.equal(parseTerminalCommand("please stop the tests from running on CI"), undefined, "long requests are requests");
});

test("the model's stop_pi stops pi only when the developer's words were 'stop pi', whatever arrives first", async () => {
	const h = harness();
	h.pi.idle = false;
	h.s.setPiBusy(true);
	const stopCall = (id: string) => h.ev("response.function_call_arguments.done", { call_id: id, name: "stop_pi", arguments: "{}" });
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	};
	// The model calls stop_pi before the turn's transcript arrives: it waits for the words.
	h.ev("input_audio_buffer.speech_started");
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "t1" });
	stopCall("c1");
	await settle();
	assert.equal(h.outputs().length, 0, "held until the words are known");
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "t1", transcript: "Stop." });
	await settle();
	assert.equal(h.pi.aborted, 0, '"Stop." stops the voice, never pi');
	assert.equal(h.outputs().at(-1).stopped, false);
	// "stop pi": stopped once (the local command), the model's call reports it.
	h.ev("input_audio_buffer.committed", { item_id: "t2" });
	stopCall("c2");
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "t2", transcript: "stop pi" });
	await settle();
	assert.equal(h.pi.aborted, 1);
	assert.equal(h.outputs().at(-1).stopped, true);
	// Transcript first, then the call: still once.
	h.say("Cancel that.");
	stopCall("c3");
	await settle();
	assert.equal(h.pi.aborted, 2);
	// No transcript in time: not stopped.
	h.ev("input_audio_buffer.committed", { item_id: "t4" });
	stopCall("c4");
	h.clock.advance(TRANSCRIPT_WAIT_MS * 4);
	await settle();
	assert.equal(h.pi.aborted, 2);
	assert.equal(h.outputs().at(-1).stopped, false);
});

test("answer_question: with several questions open the id is required, and an unknown id answers nothing", async () => {
	const h = harness();
	const answers: unknown[] = [];
	h.s.ask({ id: "local", kind: "confirm", title: "Overwrite notes.txt?" }, (v) => answers.push(["local", v]));
	h.s.ask({ id: "herdr-1", kind: "confirm", title: "Api asks: Run the tests?" }, (v) => answers.push(["herdr", v]));
	h.say("No.");
	const out = await h.call("answer_question", { answer: "no" });
	assert.match(out.error, /2 questions are open \(id local: Overwrite notes\.txt\?; id herdr-1: Api asks: Run the tests\?\)/);
	assert.match((await h.call("answer_question", { id: "nope", answer: "no" })).error, /no open question has id nope/);
	assert.deepEqual(answers, []);
	assert.deepEqual(await h.call("answer_question", { id: "herdr-1", answer: "no" }), { answered: false });
	assert.deepEqual(answers, [["herdr", false]]);
	// One left: no id needed.
	assert.deepEqual(await h.call("answer_question", { answer: "no" }), { answered: false });
	assert.deepEqual(answers, [
		["herdr", false],
		["local", false],
	]);
});

test("ask_pi to another session after an unconfirmed delivery: the model can't send the same request again", async () => {
	const asks: string[] = [];
	const h = harness("normal", {
		targets: {
			label: () => "api @devbox",
			ask: async (text) => {
				asks.push(text);
				return { delivered: "unconfirmed", note: "may have arrived" };
			},
			list: async () => ({}),
			switchTo: async () => ({}),
			status: async () => "",
			stop: async () => ({}),
		},
	});
	assert.equal((await h.call("ask_pi", { request: "Deploy the docs." })).delivered, "unconfirmed");
	const again = await h.call("ask_pi", { request: "deploy the docs" });
	assert.equal(again.delivered, false);
	assert.match(again.error, /Not sent again/);
	assert.deepEqual(asks, ["Deploy the docs."]);
	// Another request goes; after two minutes the same one may go again.
	await h.call("ask_pi", { request: "Run the tests." });
	h.clock.advance(UNCONFIRMED_MS);
	await h.call("ask_pi", { request: "Deploy the docs." });
	assert.deepEqual(asks, ["Deploy the docs.", "Run the tests.", "Deploy the docs."]);
});

test("listening sounds and coughs get no reply", () => {
	const h = harness();
	h.say("mm-hmm");
	h.ev("response.created");
	assert.ok(h.types().includes("response.cancel"), "the reply already asked for is cancelled");
	assert.ok(isBackchannel("Right."));
	assert.ok(!isBackchannel("Right, now rename it."));
});

// ── typing gate ──

test("typing gate: a pause is 1.5 s without a key", () => {
	let now = 0;
	const g = new TypingGate(1500, () => now);
	assert.equal(g.typing(), false);
	g.key();
	now = 1000;
	assert.equal(g.typing(), true);
	assert.equal(g.wait(), 500);
	now = 1500;
	assert.equal(g.typing(), false);
	assert.equal(g.wait(), 0);
});

test("speech waits until typing stops; questions and failures sound at once and speak at the pause", () => {
	const h = harness();
	h.s.key();
	h.clock.advance(100);
	h.s.announce("done", "Renamed, tests pass.");
	h.clock.advance(1000);
	h.s.key(); // still typing
	h.clock.advance(1499);
	assert.deepEqual(h.injected(), [], "nothing spoken within 1.5 s of a key");
	assert.deepEqual(h.played, [], "the done sound waits with the speech");
	h.clock.advance(1);
	assert.deepEqual(h.played, ["done"]);
	assert.match(h.injected()[0], /^\[PI\] SAY: "Renamed, tests pass\."/);
	assert.equal(h.types().at(-1), "response.create");

	const q = harness();
	q.s.key();
	q.s.announce("question", "Push to main too?");
	assert.deepEqual(q.played, ["attention"], "the question's sound plays at once, even while typing");
	assert.deepEqual(q.injected(), []);
	q.clock.advance(1500);
	assert.match(q.injected()[0], /Push to main too\?/);

	const f = harness();
	f.s.key();
	f.s.announce("failed", "Heads-up: a deployment failed.");
	assert.deepEqual(f.played, ["failed"]);
	assert.deepEqual(f.injected(), []);
	f.clock.advance(1500);
	assert.match(f.injected()[0], /a deployment failed/);
});

test("speech also waits while the developer talks or a reply is in flight; a newer outcome replaces an unspoken one", () => {
	const h = harness();
	h.ev("input_audio_buffer.speech_started");
	h.s.announce("done", "First.");
	h.s.announce("done", "Second.");
	assert.deepEqual(h.injected(), []);
	h.ev("input_audio_buffer.speech_stopped");
	h.ev("input_audio_buffer.committed", { item_id: "x" });
	h.ev("conversation.item.input_audio_transcription.completed", { item_id: "x", transcript: "What's next?" });
	assert.deepEqual(h.injected(), [], "their reply goes first");
	h.ev("response.created");
	h.ev("response.done", { response: { status: "completed" } });
	assert.equal(h.injected().length, 1);
	assert.match(h.injected()[0], /SAY: "Second\."/);
});

test("the working tick: every few seconds while pi works, never while typing, never in Quiet", () => {
	const h = harness();
	h.s.setPiBusy(true);
	h.clock.advance(TICK_MS);
	assert.deepEqual(h.played, ["working"]);
	for (let t = 0; t < 10_000; t += 500) {
		h.s.key();
		h.clock.advance(500);
	}
	assert.deepEqual(h.played, ["working"], "no tick while typing");
	h.clock.advance(2000);
	assert.deepEqual(h.played, ["working", "working"]);
	h.s.setPiBusy(false);
	h.clock.advance(TICK_MS * 2);
	assert.equal(h.played.length, 2);

	const q = harness("quiet");
	q.s.setPiBusy(true);
	q.clock.advance(TICK_MS * 3);
	assert.deepEqual(q.played, []);
});

// ── parking ──

test("park detection: trailing pointing words", () => {
	for (const t of ["rename it to the following", "Rename it to the following.", "use this:", "change it to…", "change it to...", "rename the file to", "save it as", "add the following please", "put this below"])
		assert.equal(pointsAhead(t), true, t);
	for (const t of ["what's the weather in Ireland today", "rename it to foo", "run the tests", "to", "", "What does the login flow do?"]) assert.equal(pointsAhead(t), false, t);
	// "This" means the editor's text when there is any, else the last thing pi showed (a complete request).
	assert.equal(pointsAhead("rename it to this", true), true);
	assert.equal(pointsAhead("rename it to this", false), false);
	assert.equal(pointsAhead("explain that", false), false);
});

test("park line: marked spoken words, typed text verbatim, one message", () => {
	assert.equal(parkLine("rename it to the following."), `${PARK_MARK}rename it to the following: `);
	assert.equal(parkLine("rename it to this", "fooBar.ts"), `${PARK_MARK}rename it to this: fooBar.ts`);
	const typed = `${parkLine("use this:")}  const X = \`a_b\`; // Exact`;
	assert.equal(parkedMessage(typed), "use this:   const X = `a_b`; // Exact");
	assert.ok(isParkedText(typed));
	assert.equal(unmark("plain"), "plain");
});

test("a spoken request that points ahead parks in the editor; the voice says nothing; 'send' sends one message", () => {
	const h = harness();
	h.say("Rename it to the following.");
	h.ev("response.created");
	h.ev("output_audio_buffer.started");
	h.s.onAudio(LOUD);
	assert.deepEqual(h.played, [], "the voice stays silent");
	assert.ok(h.types().includes("response.cancel"));
	assert.equal(h.pi.editor, `${PARK_MARK}rename it to the following: `.replace("rename", "Rename"));
	assert.equal(h.pi.hint, true);
	assert.deepEqual(h.pi.messages, [], "never auto-sent");
	assert.match(statusText(h.s.status()), /parked/);
	h.pi.editor += "foo.ts"; // typed
	h.say("Send.");
	assert.deepEqual(h.pi.messages, [{ text: "Rename it to the following: foo.ts", deliverAs: undefined }]);
	assert.equal(h.pi.editor, "");
	assert.equal(h.pi.hint, false);
	assert.equal(h.s.parked, undefined);
});

test("the model's ask_pi cannot send a request that points ahead; park and send_parked tools", async () => {
	const h = harness();
	const out = await h.call("ask_pi", { request: "change the title to" });
	assert.equal(out.parked, true);
	assert.deepEqual(h.pi.messages, []);
	assert.ok(isParkedText(h.pi.editor));
	assert.ok(!h.types().slice(-1).includes("response.create"), "silent after parking");
	h.pi.editor += "Voice and text";
	// A parked request never sends itself: the model's send_parked without the developer saying "send" does nothing.
	assert.equal((await h.call("send_parked", {})).sent, false);
	h.say("What's the time?");
	assert.equal((await h.call("send_parked", {})).sent, false);
	assert.deepEqual(h.pi.messages, []);
	assert.ok(isParkedText(h.pi.editor));
	// "Send": sent by the local command; the model's call for the same turn only reports it.
	h.say("Send.");
	assert.deepEqual(await h.call("send_parked", {}), { sent: true });
	assert.deepEqual(h.pi.messages, [{ text: "change the title to: Voice and text", deliverAs: undefined }]);

	const g = harness();
	await g.call("park", { words: "use this" });
	assert.equal(g.pi.editor, `${PARK_MARK}use this: `);
	// Esc: the spoken part becomes plain text and nothing is parked.
	assert.equal(g.s.unpark(), true);
	assert.equal(g.pi.editor, "use this: ");
	assert.equal(g.pi.hint, false);
});

test("the model's park call, cut short by the local park's cancel, keeps the spoken words in the editor", async () => {
	const h = harness();
	h.say("Add a line to notes.txt that says the following.");
	assert.equal(h.pi.editor, `${PARK_MARK}Add a line to notes.txt that says the following: `);
	// The cancelled response's call arrives with its arguments truncated.
	h.ev("response.function_call_arguments.done", { call_id: "c-cut", name: "park", arguments: '{"words' });
	await new Promise((r) => setImmediate(r));
	assert.equal(h.pi.editor, `${PARK_MARK}Add a line to notes.txt that says the following: `);
	// Sent with Enter: the voice is told, and a late send_parked does not silence what it should say.
	h.pi.editor = ""; // Enter submitted and cleared it
	h.s.parkSubmitted();
	assert.match(h.injected().at(-1)!, /parked request was sent with Enter; nothing is parked now/);
	h.ev("response.created");
	h.ev("response.done", { response: { status: "cancelled" } });
	const n = h.types().filter((t) => t === "response.create").length;
	const out = await h.call("send_parked", {});
	assert.equal(out.sent, false);
	assert.match(out.note, /say it now/);
	assert.equal(h.types().filter((t) => t === "response.create").length, n + 1, "a reply is asked for");
});

test("with text in the editor, 'rename it to this' assembles one line; without, 'this' is the last thing pi showed", async () => {
	const h = harness();
	h.pi.editor = "loginFlow.ts";
	h.say("Rename it to this.");
	assert.equal(h.pi.editor, `${PARK_MARK}Rename it to this: loginFlow.ts`);
	const g = harness();
	g.say("Explain this.");
	assert.equal(g.pi.editor, "");
	assert.equal(g.s.parked, undefined);
	await g.call("ask_pi", { request: "Explain this." });
	assert.deepEqual(g.pi.messages, [{ text: "Explain this.", deliverAs: undefined }]);
	// What "this" is reaches the voice model as context when it changes, never spoken.
	g.s.screen("", "The login flow now rejects expired tokens.");
	g.s.screen("", "The login flow now rejects expired tokens.");
	const screens = g.injected().filter((t) => t.startsWith("[PI] SCREEN"));
	assert.equal(screens.length, 1);
	assert.match(screens[0], /the editor is empty\. The last thing pi showed: The login flow/);
});

// ── requests and tools ──

test("a complete spoken request goes to pi at once; steers when pi is busy", async () => {
	const h = harness();
	const out = await h.call("ask_pi", { request: "What's the weather in Ireland today?" });
	assert.equal(out.delivered, "prompt");
	assert.deepEqual(h.pi.messages, [{ text: "What's the weather in Ireland today?", deliverAs: undefined }]);
	assert.ok(h.played.includes("heard"), "a sound says pi is on it");
	assert.equal(h.s.status().state, "working");
	h.pi.idle = false;
	assert.equal((await h.call("ask_pi", { request: "also update the docs" })).delivered, "steer");
	assert.equal((await h.call("ask_pi", { request: "then run the tests", when: "after" })).delivered, "followUp");
	assert.deepEqual(
		h.pi.messages.map((m) => m.deliverAs),
		[undefined, "steer", "followUp"],
	);
});

test("pi's questions by voice: read out, answered aloud, irreversible ones need the action named", async () => {
	const h = harness();
	let answer: unknown = "unanswered";
	h.s.ask({ id: "q1", kind: "confirm", title: "Deploy to production?", message: "This ships main." }, (v) => (answer = v));
	assert.deepEqual(h.played, ["attention"]);
	assert.match(h.injected()[0], /SAY: "Deploy to production\? This ships main\. Say "yes, deploy" to confirm, or no\."/);
	assert.match(h.injected()[0], /QUESTION \(id q1, confirm, DESTRUCTIVE/);
	h.ev("response.created");
	h.ev("response.done", { response: { status: "completed" } });
	// The voice model never answers for the developer: nothing was said since the question.
	assert.match((await h.call("answer_question", { answer: "yes, deploy" })).error, /has not answered yet/);
	assert.equal(answer, "unanswered");
	h.ev("input_audio_buffer.committed", { item_id: "their-answer" });
	assert.match((await h.call("answer_question", { answer: "yeah" })).error, /yes, deploy/);
	assert.equal(answer, "unanswered");
	assert.deepEqual(await h.call("answer_question", { answer: "yes, deploy" }), { answered: true });
	assert.equal(answer, true);
	assert.equal(answerFor({ id: "s", kind: "select", title: "Which?", options: ["Keep both", "Use mine"] }, "option two").hasOwnProperty("value"), true);
	assert.match(speakPrompt({ id: "s", kind: "select", title: "Which?", options: ["a", "b", "c"] }), /one: a\. two: b\. There are 3 on screen\./);
	// Answered in the terminal: the unspoken question is dropped.
	const g = harness();
	g.s.key();
	g.s.ask({ id: "q2", kind: "confirm", title: "Continue?" }, () => {});
	g.s.closePrompt("q2");
	g.clock.advance(2000);
	assert.deepEqual(g.injected(), []);
});

// ── output routing and switches ──

test("output routing: what makes a sound, what is spoken, per switch", () => {
	assert.deepEqual(route("done", "normal"), { soundAtPause: "done", speak: true });
	assert.deepEqual(route("question", "normal"), { soundNow: "attention", speak: true });
	assert.deepEqual(route("failed", "eyes-free"), { soundNow: "failed", speak: true });
	for (const k of ["done", "question", "failed"] as const) assert.equal(route(k, "quiet").speak, false, `${k} is never spoken in Quiet`);
	assert.equal(route("question", "quiet").soundNow, "attention", "Quiet keeps the sounds");

	const q = harness("quiet");
	q.s.announce("done", "Renamed.");
	q.s.announce("question", "Push?");
	q.clock.advance(5000);
	assert.deepEqual(q.played, ["done", "attention"]);
	assert.deepEqual(q.injected(), [], "nothing spoken");
	q.ev("response.created");
	q.ev("output_audio_buffer.started");
	q.s.onAudio(LOUD);
	assert.ok(!q.played.includes("audio"), "the voice's audio is dropped in Quiet");
	q.ev("response.output_audio_transcript.done", { transcript: "Three tests left." });
	assert.deepEqual(q.pi.notes, ["voice: Three tests left."], "what it would have said is shown instead");
});

test("the switches by voice and by tool: persisted, and the voice's instructions follow", async () => {
	const h = harness();
	h.say("Go quiet.");
	assert.equal(h.s.sw, "quiet");
	h.say("I can't look.");
	assert.equal(h.s.sw, "eyes-free");
	assert.deepEqual(h.switches, ["quiet", "eyes-free"]);
	const updates = h.sent.filter((e) => e.type === "session.update").map((e) => e.session.instructions);
	assert.deepEqual(updates, ["instructions for quiet", "instructions for eyes-free"]);
	assert.match(statusText(h.s.status()), /voice: listening · eyes-free/);
	await h.call("voice_setting", { setting: "normal" });
	assert.equal(h.s.sw, "normal");
	assert.equal(statusText(h.s.status()), "voice: listening");
	assert.equal(parseTerminalCommand("quiet mode"), "quiet");
	assert.equal(parseTerminalCommand("eyes free"), "eyesFree");
	assert.equal(parseTerminalCommand("I can look again"), "normal");
});

// ── the said line and briefs ──

const answerMsg = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
const branch = [{ type: "message", message: { role: "user", content: "rename getUser to fetchUser" } }];

test("the said line: the one spoken sentence, shown above pi's answer; none in Quiet", async () => {
	const complete = async (system: string) => {
		assert.match(system, /Exactly one sentence/);
		return "Renamed, and the imports are updated.\nMORE: which files";
	};
	const out = await answerOutput(answerMsg("Renamed `getUser` to `fetchUser` in 3 files.\n\n- src/a.ts\n- src/b.ts"), branch, "normal", complete);
	assert.deepEqual([out.kind, out.sentence, out.said], ["done", "Renamed, and the imports are updated.", "Renamed, and the imports are updated."]);
	assert.match(out.context, /^REPORT/);
	const quiet = await answerOutput(answerMsg("Renamed."), branch, "quiet", complete);
	assert.equal(quiet.said, undefined);
	assert.equal(quiet.sentence, "");
	const q = await answerOutput(answerMsg("Done. Should I also push?"), branch, "normal", async () => "Renamed; should I push it too?");
	assert.equal(q.kind, "question");
	const err = await answerOutput({ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" }, branch, "normal");
	assert.equal(err.kind, "failed");
	// A slow model: the answer's first sentence, within the time limit.
	const t0 = Date.now();
	const slow = await answerOutput(answerMsg("The tests pass now. I changed two files."), branch, "normal", (_s, _u, o) => new Promise((_r, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("aborted")))), 50);
	assert.equal(slow.said, "The tests pass now.");
	assert.ok(Date.now() - t0 < 1000);
	assert.equal(isFinalAnswer(answerMsg("x")), true);
	assert.equal(isFinalAnswer({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" }), false);
	assert.equal(isFinalAnswer({ ...answerMsg("x"), stopReason: "aborted" }), false);
});

test("the said line is a custom entry rendered in the voice colour; /voice and the shortcut are registered", () => {
	delete (globalThis as any)[Symbol.for("pi-speech.voice")];
	const reg: Record<string, any> = { renderers: {}, commands: {}, shortcuts: {}, events: {} };
	const fakePi: any = {
		registerEntryRenderer: (type: string, r: any) => (reg.renderers[type] = r),
		registerCommand: (name: string, o: any) => (reg.commands[name] = o),
		registerShortcut: (key: string, o: any) => (reg.shortcuts[key] = o),
		on: (name: string, f: any) => (reg.events[name] = f),
	};
	registerVoiceMode(fakePi, async () => "");
	const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` };
	const comp = reg.renderers[SAID]({ data: { text: "Renamed, tests pass." } }, { expanded: false }, theme);
	const lines = comp.render(80).join("\n");
	assert.match(lines, /<accent>\*said\*<\/accent>  <accent>Renamed, tests pass\.<\/accent>/);
	assert.equal(reg.renderers[SAID]({ data: {} }, { expanded: false }, theme), undefined);
	assert.ok(reg.commands.voice);
	assert.ok(reg.shortcuts[voiceShortcut()]);
	for (const e of ["message_end", "input", "before_agent_start", "tool_execution_end", "agent_settled", "session_shutdown"]) assert.ok(reg.events[e], e);
	delete (globalThis as any)[Symbol.for("pi-speech.voice")];
});

// ── voice mode in pi: start, stop, shutdown (fake devices, call and pi; never the speakers) ──

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = async (n = 5) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * registerVoiceMode with a fake pi, a fake terminal and every device faked. Each step of start
 * (credentials, player, call, microphone) waits on a gate the test opens, so a test can stop the
 * voice in the middle of any of them.
 */
function voiceMode(o: { gated?: boolean } = {}) {
	const CLAIM = Symbol.for("pi-speech.voice");
	delete (globalThis as any)[CLAIM];
	const clock = new FakeClock();
	const events: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const shortcuts: Record<string, any> = {};
	const entries: { type: string; data: any }[] = [];
	const messages: string[] = [];
	const fakePi: any = {
		registerEntryRenderer() {},
		registerCommand: (n: string, c: any) => (commands[n] = c),
		registerShortcut: (k: string, s: any) => (shortcuts[k] = s),
		on: (n: string, f: any) => (events[n] = f),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		sendUserMessage: (t: string) => messages.push(t),
	};
	const notes: [string, string][] = [];
	const status = new Map<string, string | undefined>();
	const inputs = new Set<(d: string) => any>();
	const dialogCalls: string[] = [];
	const origSelect = async (title: string, _options: string[], opts?: any) => {
		dialogCalls.push(title);
		return new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined)));
	};
	const ui: any = {
		editor: "",
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		notify: (m: string, l: string) => notes.push([m, l]),
		setStatus: (k: string, v: string | undefined) => status.set(k, v),
		setWidget() {},
		getEditorText: () => ui.editor,
		setEditorText: (t: string) => (ui.editor = t),
		onTerminalInput: (f: (d: string) => any) => {
			inputs.add(f);
			return () => inputs.delete(f);
		},
		select: origSelect,
		confirm: async () => false,
		input: async () => undefined,
	};
	const ctx: any = { mode: "tui", hasUI: true, ui, cwd: "/tmp/proj", isIdle: () => true, abort() {}, sessionManager: { getBranch: () => [] } };
	const opened = { player: 0, link: 0, capture: 0 };
	const closed = { player: 0, link: 0, capture: 0 };
	const sent: any[] = [];
	const gates = { credentials: deferred<void>(), player: deferred<void>(), link: deferred<void>(), capture: deferred<void>() };
	const gate = async (k: keyof typeof gates) => {
		if (o.gated) await gates[k].promise;
	};
	let linkClose: ((why: string) => void) | undefined;
	let micError: ((m: string) => void) | undefined;
	let onEvent: ((ev: any) => void) | undefined;
	const deps = {
		clock,
		herdrExec: async () => ({ code: 1, stdout: "", stderr: "" }),
		credentials: async () => {
			await gate("credentials");
			return { kind: "api-key", apiKey: "test" } as any;
		},
		hints: async () => [],
		openPlayer: async () => {
			await gate("player");
			opened.player++;
			return { write() {}, flush() {}, close: () => void closed.player++, target: "none" };
		},
		connectRealtime: async () => {
			await gate("link");
			opened.link++;
			return {
				callId: "call-1",
				send: (ev: any) => sent.push(ev),
				onEvent: (f: (ev: any) => void) => (onEvent = f),
				onAudio() {},
				onClose: (f: (why: string) => void) => (linkClose = f),
				sendPcm() {},
				close: async () => void closed.link++,
			};
		},
		startCapture: async (_pcm: any, onError: (m: string) => void) => {
			micError = onError;
			await gate("capture");
			opened.capture++;
			return { stop: () => void closed.capture++ };
		},
	};
	const register = () => registerVoiceMode(fakePi, async () => "", { careful: async () => "", deps: deps as any });
	register();
	const on = () => /Voice mode on/.test(notes.map((n) => n[0]).join("\n"));
	const release = () => {
		for (const g of Object.values(gates)) g.resolve();
	};
	return {
		CLAIM,
		clock,
		events,
		commands,
		shortcuts,
		entries,
		messages,
		notes,
		status,
		inputs,
		ui,
		ctx,
		origSelect,
		dialogCalls,
		opened,
		closed,
		sent,
		gates,
		release,
		register,
		on,
		toggle: () => shortcuts[voiceShortcut()].handler(ctx),
		linkClose: (why: string) => linkClose?.(why),
		micError: (m: string) => micError?.(m),
		event: (ev: any) => onEvent?.(ev),
		/** The developer says something (a server VAD turn and its transcript). */
		say: (transcript: string) => {
			const item = `i${Math.random()}`;
			onEvent?.({ type: "input_audio_buffer.committed", item_id: item });
			onEvent?.({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript });
		},
		done: () => delete (globalThis as any)[CLAIM],
	};
}

const openTotal = (v: ReturnType<typeof voiceMode>) => v.opened.player + v.opened.link + v.opened.capture;
const closedTotal = (v: ReturnType<typeof voiceMode>) => v.closed.player + v.closed.link + v.closed.capture;

test("voice mode stopped while starting, at every step: nothing it opened is left running", async () => {
	for (const step of ["credentials", "player", "link", "capture"] as const) {
		for (const how of ["alt+v", "call lost", "microphone error"] as const) {
			if (how === "call lost" && step !== "capture") continue; // the call exists only from then on
			if (how === "microphone error" && step !== "capture") continue;
			const v = voiceMode({ gated: true });
			const at = `${step}/${how}`;
			const starting = v.toggle();
			const order = ["credentials", "player", "link", "capture"] as const;
			for (const s of order.slice(0, order.indexOf(step))) v.gates[s].resolve();
			await tick(10);
			if (how === "alt+v") await v.toggle();
			else if (how === "call lost") v.linkClose("connection failed");
			else v.micError("no microphone");
			v.release(); // the step that was waiting finishes after the stop
			await starting;
			await tick(10);
			assert.equal(closedTotal(v), openTotal(v), `${at}: every opened device and call is closed`);
			assert.equal(v.on(), false, `${at}: never announced as on`);
			assert.equal(v.inputs.size, 0, `${at}: no terminal listener left`);
			assert.equal(v.clock.pending(), 0, `${at}: no timers left`);
			// And it can start again.
			await v.toggle();
			await tick(10);
			assert.equal(v.on(), true, `${at}: starts again`);
			await v.toggle();
			v.done();
		}
	}
});

test("stop releases everything: microphone, player, call, terminal listener, timers, status line", async () => {
	const v = voiceMode();
	await v.toggle();
	assert.equal(v.on(), true);
	assert.deepEqual(v.opened, { player: 1, link: 1, capture: 1 });
	for (const f of v.inputs) f("x"); // a key: the screen update timer
	assert.ok(v.clock.pending() > 0);
	await v.toggle();
	assert.deepEqual(v.closed, { player: 1, link: 1, capture: 1 });
	assert.equal(v.inputs.size, 0);
	assert.equal(v.clock.pending(), 0, "the tick, the screen update and the session's timers are gone");
	assert.equal(v.status.get("pi-speech-voice"), undefined);
	assert.match(v.notes.at(-1)![0], /Voice mode off/);
	v.done();
});

test("pi shuts down (or /reload) while voice mode starts: the start is abandoned and closed before the claim is let go", async () => {
	const v = voiceMode({ gated: true });
	const starting = v.toggle();
	v.gates.credentials.resolve();
	v.gates.player.resolve();
	await tick(10);
	let shutDown = false;
	const shutdown = v.events.session_shutdown({}, v.ctx).then(() => (shutDown = true));
	await tick(10);
	assert.equal(shutDown, false, "waits for the start to let go");
	assert.ok((globalThis as any)[v.CLAIM], "still claimed");
	v.release(); // the call connects after the shutdown
	await starting;
	await shutdown;
	assert.equal(closedTotal(v), openTotal(v));
	assert.equal(v.opened.capture, 0, "the microphone was never opened");
	assert.equal(v.on(), false);
	assert.equal((globalThis as any)[v.CLAIM], undefined, "the next pi may claim voice mode");
	assert.equal(v.inputs.size, 0);
});

test("shutdown puts pi's dialogs back; after /reload the new voice mode answers them by voice", async () => {
	const v = voiceMode();
	await v.toggle();
	assert.notEqual(v.ui.select, v.origSelect, "wrapped while voice mode is on");
	await v.events.session_shutdown({}, v.ctx);
	assert.equal(v.ui.select, v.origSelect, "pi's own dialog again");
	// /reload: the extension registers again on the same terminal.
	v.register();
	await v.toggle();
	const asked = v.sent.length;
	const answer = v.ui.select("Which color?", ["red", "green"]);
	await tick();
	assert.ok(
		v.sent.slice(asked).some((e) => /QUESTION/.test(e.item?.content?.[0]?.text ?? "")),
		"the question went to the voice",
	);
	assert.deepEqual(v.dialogCalls, ["Which color?"], "and is on screen");
	// Answered aloud: the terminal's dialog closes with that answer.
	v.say("The second one.");
	v.event({ type: "response.function_call_arguments.done", call_id: "c-answer", name: "answer_question", arguments: JSON.stringify({ answer: "the second one" }) });
	assert.equal(await Promise.race([answer, tick(20).then(() => "no answer")]), "green");
	await v.events.session_shutdown({}, v.ctx);
	assert.equal(v.ui.select, v.origSelect);
	// Someone wrapped the dialogs after us: ours stays, inert, and pi's dialog still works.
	const w = voiceMode();
	await w.toggle();
	const ours = w.ui.select;
	const theirs = (...a: any[]) => ours(...a);
	w.ui.select = theirs;
	await w.events.session_shutdown({}, w.ctx);
	assert.equal(w.ui.select, theirs);
	const plain = w.ui.select("Plain?", ["a", "b"], { signal: AbortSignal.abort() });
	await tick();
	assert.deepEqual(w.dialogCalls, ["Plain?"]);
	void plain;
	w.done();
});

test("the parked marker never reaches pi: Enter sends the words and the typed text verbatim; '● ' typed by hand is text", async () => {
	const v = voiceMode();
	// Voice mode off, or nothing parked: a line that starts with the marker is the developer's own.
	assert.deepEqual(await v.events.input({ text: `${PARK_MARK}a bullet`, source: "interactive" }), { action: "continue" });
	await v.toggle();
	assert.deepEqual(await v.events.input({ text: `${PARK_MARK}a bullet`, source: "interactive" }), { action: "continue" });
	// Something parked: the marker is stripped, the typed text kept verbatim.
	v.say("Rename it to the following.");
	assert.equal(v.ui.editor, `${PARK_MARK}Rename it to the following: `);
	v.ui.editor += "foo.ts";
	assert.deepEqual(await v.events.input({ text: v.ui.editor, source: "interactive" }), { action: "transform", text: "Rename it to the following: foo.ts" });
	assert.deepEqual(await v.events.input({ text: "plain", source: "interactive" }), { action: "continue" });
	// Voice mode ends with a request parked: it stays as plain text, no marker left behind.
	v.say("Use this:");
	assert.ok(v.ui.editor.startsWith(PARK_MARK));
	await v.toggle();
	assert.equal(v.ui.editor, "Use this: ");
	v.done();
});

test("Esc in a voice-mode draft keeps the words not drafted yet below the draft", async () => {
	initTheme("dark", false);
	const theme = {
		colors: { userMessageBg: rgbColor(40, 40, 40), accent: rgbColor(0, 160, 255) },
		getColorMode: () => "truecolor",
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		italic: (t: string) => t,
		strikethrough: (t: string) => t,
	} as any;
	let view: any;
	const ui: any = {
		theme,
		editor: "typed before",
		notify() {},
		setWidget() {},
		setStatus() {},
		getEditorText: () => ui.editor,
		setEditorText: (t: string) => (ui.editor = t),
		onTerminalInput: () => () => {},
		custom(factory: any) {
			const tui = { terminal: { rows: 40, columns: 100 }, children: [], requestRender() {}, addInputListener: () => () => {} };
			view = factory(tui, theme, {}, () => {});
			return new Promise(() => {});
		},
	};
	const ctx: any = { mode: "tui", hasUI: true, cwd: mkdtempSync(join(tmpdir(), "pi-speech-vdraft-")), ui, isIdle: () => true, sessionManager: { getBranch: () => [] } };
	// The first update drafts what was said; the next one never answers, so its words stay not drafted.
	const updates: string[] = [];
	const fast = async (_system: string, user: string) => {
		const speech = /NEW SPEECH[^\n]*:\n([\s\S]*)$/.exec(user)?.[1] ?? "";
		updates.push(speech);
		if (updates.length > 1) await new Promise(() => {});
		return JSON.stringify({ kind: "description", edits: [{ op: "add", section: "Requirements", text: "Retry uploads with backoff" }] });
	};
	const closed: string[] = [];
	const d = new VoiceDraft(
		{ ctx, fast, careful: async () => '{"edits": []}', send() {}, target: () => undefined },
		{ seed: "We need upload retries with exponential backoff.", since: Date.now(), reason: "intent" },
		{ finish() {}, closed: (how) => closed.push(how) },
	);
	const until = async (f: () => boolean, what: string) => {
		const end = Date.now() + 3000;
		while (!f()) {
			if (Date.now() > end) throw new Error(`timed out: ${what}`);
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	try {
		await until(() => d.draft.markdown().includes("Retry uploads with backoff"), "the first update");
		d.content("And the error message should say when it retries.");
		await until(() => updates.length === 2, "the second update in flight");
		view.handleInput("\x1b");
		assert.equal(ui.editor, `typed before\n\n## Requirements\n\n- Retry uploads with backoff\n\n## ${ALSO_NOT_DRAFTED}\n\nAnd the error message should say when it retries.`);
		assert.deepEqual(closed, ["kept"]);
	} finally {
		d.discard();
	}
});

test("the voice log is private to the developer (0600)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-speech-log-"));
	const path = join(dir, "voice.jsonl");
	process.env.PI_SPEECH_VOICE_LOG = path;
	try {
		const v = voiceMode();
		await v.toggle();
		await v.toggle();
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.match(readFileSync(path, "utf8"), /"voice":"on"/);
		v.done();
	} finally {
		delete process.env.PI_SPEECH_VOICE_LOG;
	}
});

test("briefs for the terminal: one sentence at the desk, longer eyes-free; the question wins", () => {
	assert.match(BRIEF_SYSTEM("glance", "terminal"), /Exactly one sentence/);
	assert.match(BRIEF_SYSTEM("glance", "terminal"), /headphones/);
	assert.match(BRIEF_SYSTEM("eyes-busy", "terminal"), /cannot look at the screen/);
	assert.match(BRIEF_SYSTEM("glance"), /listening on their phone/, "the phone's brief is unchanged");
	const d = runDigest([...branch, { type: "message", message: answerMsg("Renamed it everywhere. Three files changed. Want me to push?") }]);
	assert.equal(heuristicBrief(d, "glance", "terminal").speech, "Want me to push?");
	const e = runDigest([...branch, { type: "message", message: answerMsg("Renamed it everywhere. Three files changed. Tests pass.") }]);
	assert.equal(heuristicBrief(e, "glance", "terminal").speech, "Renamed it everywhere.");
	assert.equal(heuristicBrief(e, "eyes-busy", "terminal").speech, "Renamed it everywhere. Three files changed.");
	assert.match(terminalVoiceNote("glance"), /headphones at this computer/);
});

// ── the voice never knows; pi knows (#5) ──

test("issue #5: anything needing a tool, a file or current information goes to pi, on both surfaces", () => {
	for (const surface of ["phone", "terminal"] as const)
		for (const mode of ["glance", "eyes-busy"] as const) {
			const i = voiceInstructions(mode, "p", "", "", surface);
			const at = `${surface}/${mode}`;
			assert.match(i, /The voice never knows; pi knows/, at);
			assert.match(i, /Anything that needs a tool, a file or current information goes to pi/, at);
			assert.match(i, /never answer it from your own knowledge/, at);
			assert.match(i, /Answer yourself only from this conversation or for voice controls/, at);
			assert.match(i, /what's the weather in Dublin today/, at);
			// Lookups get one word; work gets none.
			assert.match(i, /Acknowledge lookups, not work/, at);
			assert.match(i, /exactly one word, "Checking\.", then ask_pi/, at);
			assert.match(i, /A request for work .* gets no words at all/, at);
			assert.match(i, /Apart from "Checking\." for a lookup, never announce/, at);
		}
	assert.match(voiceInstructions("glance", "p"), /through their phone/, "the phone stays the default");
});

test("terminal instructions and tools: one sentence, SAY exactly, parking, explicit stop pi, the switches", () => {
	const i = voiceInstructions("glance", "p", "", "", "terminal");
	assert.match(i, /headphones at that computer/);
	assert.match(i, /in one sentence; everything else is text on their screen/);
	assert.match(i, /\[PI\] SAY message carries those words: say them verbatim, word for word/);
	assert.match(i, /call draft and say nothing/);
	assert.match(i, /call park with their words and say nothing/);
	assert.match(i, /Interrupting you never stops pi/);
	assert.match(i, /Only an explicit "stop pi", "cancel that"/);
	assert.match(i, /"Go quiet": call voice_setting with quiet/);
	assert.match(voiceInstructions("eyes-busy", "p", "", "", "terminal"), /cannot look at the screen \(eyes-free\)/);
	assert.deepEqual(
		TERMINAL_TOOLS.map((t) => t.name),
		["ask_pi", "answer_question", "stop_pi", "pi_status", "pi_details", "park", "send_parked", "draft", "switch_session", "list_sessions", "voice_setting", "remain_silent"],
	);
	// One voice, many sessions: switching, "anything need me?", and back.
	assert.match(i, /call switch_session with the name as they said it/);
	assert.match(i, /"Anything need me\?".*call list_sessions/);
	assert.match(i, /"Back to this one".*switch_session with "this one"/);
	assert.match(TERMINAL_TOOLS.find((t) => t.name === "stop_pi")!.description, /Never for 'stop' alone/);
	const s: any = realtimeSession({ mode: "eyes-busy", project: "p", surface: "terminal", turnDetection: "server" });
	assert.equal(s.tools, TERMINAL_TOOLS);
	assert.equal(s.audio.input.noise_reduction.type, "near_field", "a headset, whatever the switch");
	assert.deepEqual(s.audio.input.turn_detection, { type: "server_vad", silence_duration_ms: 700, create_response: false, interrupt_response: false });
	const phone: any = realtimeSession({ mode: "eyes-busy", project: "p" });
	assert.equal(phone.tools, VOICE_TOOLS, "the phone keeps its tools");
	assert.equal(phone.audio.input.noise_reduction.type, "far_field");
	assert.equal(phone.audio.input.turn_detection.type, "semantic_vad");
});

// ── audio pieces ──

test("earcons: the phone's specs as 48 kHz PCM", () => {
	for (const name of Object.keys(EARCONS) as (keyof typeof EARCONS)[]) {
		const pcm = earconPcm(name);
		const ms = EARCONS[name].reduce((n, [, d]) => n + d, 0) + 20;
		assert.equal(pcm.length, Math.round((ms * 48000) / 1000) * 2, name);
		let peak = 0;
		for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
		assert.ok(peak > 1000 && peak < 32768 * 0.25, `${name} peak ${peak}`);
	}
	// The attention earcon's rest is silent.
	const a = earconPcm("attention");
	const mid = Math.round(0.14 * 48000) * 2;
	assert.equal(a.readInt16LE(mid), 0);
});

test("file player: what would be heard, when; a flush cuts what was not played yet; never the speakers", () => {
	assert.deepEqual(playerTarget({ PI_SPEECH_PLAYER: "file:/tmp/x.wav" } as any), { kind: "file", path: "/tmp/x.wav" });
	assert.deepEqual(playerTarget({ PI_SPEECH_PLAYER: "none" } as any), { kind: "none" });
	assert.deepEqual(playerTarget({} as any), { kind: "device" });
	assert.deepEqual(playerCommand("/opt/homebrew/bin/ffmpeg", "darwin").args.slice(-4), ["pipe:0", "-f", "audiotoolbox", "-"]);
	assert.equal(playerCommand("/usr/bin/ffmpeg", "linux").cmd, "/usr/bin/ffplay");
	const dir = mkdtempSync(join(tmpdir(), "pi-speech-player-"));
	let now = 1000;
	const p = new FilePlayer(join(dir, "out.wav"), () => now);
	const ms = (n: number) => Buffer.alloc((n * 48000 * 2) / 1000, 1);
	p.write(ms(100));
	now += 1000;
	p.write(ms(500)); // ends at 1.5 s
	now += 100;
	p.flush(); // at 1.1 s: 0.4 s not yet played
	assert.equal(p.pcm().length, (1100 * 48000 * 2) / 1000);
	p.close();
	const file = readFileSync(join(dir, "out.wav"));
	assert.equal(file.subarray(0, 4).toString(), "RIFF");
	assert.equal(file.length, 44 + p.pcm().length);
});

test("Opus frames: 20 ms frames out of any chunking, continuous RTP sequence and timestamps", () => {
	const frames: Buffer[] = [];
	const f = new Framer();
	f.push(Buffer.alloc(1000), (x) => frames.push(x));
	f.push(Buffer.alloc(3000), (x) => frames.push(x));
	assert.equal(frames.length, 2);
	assert.ok(frames.every((x) => x.length === 1920));
	const r = new RtpFramer();
	const a = r.packet(Buffer.from([1]));
	const b = r.packet(Buffer.from([2]));
	assert.equal(a[0], 0x80);
	assert.equal(a[1], 0x80 | 111, "marker on the first packet");
	assert.equal(b[1], 111);
	assert.equal((b.readUInt16BE(2) - a.readUInt16BE(2) + 0x10000) % 0x10000, 1);
	assert.equal((b.readUInt32BE(4) - a.readUInt32BE(4)) >>> 0, 960);
});

test("a file microphone plays in real time from the first sample", () => {
	assert.deepEqual(micInputArgs("darwin", "file:/tmp/q.wav"), ["-re", "-readrate_initial_burst", "0", "-i", "/tmp/q.wav"]);
});

test("alt+v, except where pi pastes images with it", () => {
	assert.equal(voiceShortcut("darwin", {} as any), "alt+v");
	assert.equal(voiceShortcut("linux", {} as any), "alt+v");
	assert.equal(voiceShortcut("win32", {} as any), "alt+shift+v");
	assert.equal(voiceShortcut("linux", { WSL_DISTRO_NAME: "Ubuntu" } as any), "alt+shift+v");
});
