// The phone's voice logic (web/voice-core.js), loaded the way the browser loads it.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markdownBlocks as hostBlocks } from "pi-speech/draft";
import { DRAFT_SYSTEM, RECONCILE_SYSTEM } from "pi-speech/drafting";
import { PhoneDrafts } from "pi-speech/phone-drafts";

// A browser script, not a module: importing runs it and it sets globalThis.PiVoiceCore.
const script = "../web/voice-core.js";
await import(script);
const V = (globalThis as any).PiVoiceCore;

test("short utterances are instant local commands; longer ones go to pi", () => {
	assert.deepEqual(V.parseCommand("Stop pi!"), { kind: "stopPi" });
	assert.deepEqual(V.parseCommand("cancel that"), { kind: "stopPi" });
	assert.deepEqual(V.parseCommand("hey pi what's it doing?"), { kind: "status" });
	assert.deepEqual(V.parseCommand("Say that again"), { kind: "repeat" });
	assert.deepEqual(V.parseCommand("tell me more"), { kind: "more" });
	assert.deepEqual(V.parseCommand("be brief"), { kind: "shorter" });
	assert.deepEqual(V.parseCommand("goodbye"), { kind: "end" });
	assert.equal(V.parseCommand("stop using the old config loader in the hub"), null);
	assert.equal(V.parseCommand("run the tests"), null);
});

test("yes/no answers; destructive actions must be named", () => {
	const plain = { kind: "confirm", title: "Apply the formatting changes?" };
	assert.deepEqual(V.answerFor(plain, "yeah go ahead"), { value: true });
	assert.deepEqual(V.answerFor(plain, "no"), { value: false });
	assert.deepEqual(V.answerFor(plain, "what was that about"), { unclear: true });
	const push = { kind: "confirm", title: "Push 3 commits to main?" };
	assert.deepEqual(V.answerFor(push, "yeah"), { needConfirm: "push" });
	assert.deepEqual(V.answerFor(push, "yes, push it"), { value: true });
	assert.deepEqual(V.answerFor(push, "confirm"), { value: true });
	assert.deepEqual(V.answerFor(push, "no don't"), { value: false });
	assert.equal(V.speakPrompt(push), 'Push 3 commits to main? Say "yes, push" to confirm, or no.');
	assert.equal(V.speakPrompt(plain), "Apply the formatting changes? Yes or no?");
});

test("a request that named the action and its target counts for the undo window", () => {
	const p = { kind: "confirm", title: "Deploy to production?", message: "This ships the current main branch." };
	assert.equal(V.requestNames(p, "Please deploy the app to production."), true, "targets come from the question, not its elaboration");
	assert.equal(V.requestNames({ kind: "confirm", title: "Deploy main to production?" }, "deploy to production"), false, "a target named in the question must be named");
	const q = { kind: "confirm", title: "Deploy to production?" };
	assert.equal(V.requestNames(q, "Please deploy the app to production."), true);
	assert.equal(V.requestNames(q, "deploy it to staging"), false, "wrong target");
	assert.equal(V.requestNames(q, "yeah"), false);
	assert.equal(V.requestNames({ kind: "confirm", title: "Push 3 commits to origin/main?" }, "push my changes to main on origin"), true);
	assert.equal(V.requestNames({ kind: "confirm", title: "Format the file?" }, "format it"), false, "not destructive: the normal flow applies");
});

test("choices by ordinal or by name, two at a time", () => {
	const p = { kind: "select", title: "Which fix?", options: ["Cache the lookup", "Add an index", "Rewrite the query", "Delete the table"] };
	assert.deepEqual(V.answerFor(p, "the second one"), { value: "Add an index" });
	assert.deepEqual(V.answerFor(p, "option 3"), { value: "Rewrite the query" });
	assert.deepEqual(V.answerFor(p, "let's add the index"), { value: "Add an index" });
	assert.deepEqual(V.answerFor(p, "last"), { needConfirm: "delete", option: "Delete the table" });
	assert.deepEqual(V.answerFor(p, "never mind"), { value: undefined });
	assert.deepEqual(V.answerFor(p, "hmm"), { unclear: true });
	assert.equal(V.speakPrompt(p), 'Which fix? one: Cache the lookup. two: Add an index. Or say "more options". There are 4.');
	assert.equal(V.speakPrompt(p, 1), "three: Rewrite the query. four: Delete the table.");
	assert.deepEqual(V.answerFor({ kind: "input", title: "Branch name?" }, "feature voice"), { value: "feature voice" });
});

test("only significant tool activity reaches the listener", () => {
	for (const t of ["psql $DATABASE_URL -c 'select 1'", "git push origin main", "kubectl apply -f prod.yaml", "npm publish", "rm -rf build", "./deploy.sh staging"])
		assert.equal(V.isSignificant(t), true, t);
	for (const t of ["npm test", "rg getUserById src", "src/auth.ts", "git status", "tsc --noEmit"]) assert.equal(V.isSignificant(t), false, t);
});

test("backchannels and coughs don't interrupt; answers and echoes are told apart", () => {
	for (const t of ["mm-hmm", "Mhm.", "uh huh", "right", "okay", "", "hmm"]) assert.equal(V.isBackchannel(t), true, t);
	for (const t of ["stop", "wait, no", "what about the tests"]) assert.equal(V.isBackchannel(t), false, t);
	assert.equal(V.isBackchannel("okay", true), false, "while pi waits on an answer, okay is an answer");
	assert.equal(V.isEcho("Yes, deploy.", "Deploy to production now? Say “yes, deploy” to confirm."), true);
	assert.equal(V.isEcho("yes", "Say yes to confirm"), false, "one word is too little to call it an echo");
	assert.equal(V.isEcho("yes, deploy it now", "Say yes, deploy to confirm"), false);
	assert.deepEqual(V.parseCommand("What can I say?"), { kind: "help" });
	assert.match(V.HELP, /stop, to stop me talking; and stop pi, to stop its work/);
});

test("interrupting the voice never stops pi: stop is the voice, stopping pi is said explicitly", () => {
	for (const t of ["Stop.", "pi, stop", "stop it", "stop that", "okay stop", "cancel", "shush", "stop talking", "enough", "be quiet"]) assert.equal(V.parseCommand(t)?.kind, "quiet", t);
	for (const t of ["stop pi", "Stop pi.", "hey pi stop pi", "stop the work", "stop working", "cancel that", "cancel it", "cancel the request", "abort", "abort that", "stop everything"])
		assert.equal(V.parseCommand(t)?.kind, "stopPi", t);
	assert.equal(V.parseCommand("stop the old config loader from retrying"), null);
});

test("the undo window is still cancelled by stop: 'Deploying to production, say stop to cancel'", () => {
	for (const t of ["Stop.", "stop", "pi, stop", "cancel", "Cancel!", "stop it", "stop pi", "cancel that", "no", "no, wait", "wait", "hold on", "don't", "abort", "stop, don't deploy"])
		assert.equal(V.cancelsGrace(t), true, t);
	for (const t of ["yes", "go ahead", "mm-hmm", "what's it doing", "deploy it"]) assert.equal(V.cancelsGrace(t), false, t);
});

test("a long dictation is cut into chunks at pauses, or at the longest chunk", () => {
	const c = new V.Chunker({ minMs: 10_000, maxMs: 15_000, pauseMs: 300 });
	const feed = (rms: number, ms: number) => {
		const cuts: number[] = [];
		for (let t = 0; t < ms; t += 20) if (c.feed(rms, 20)) cuts.push(t + 20);
		return cuts;
	};
	assert.deepEqual(feed(0.004, 500), [], "silence before speaking: no chunk yet");
	assert.deepEqual(feed(0.2, 9_000), [], "speech under the minimum");
	assert.deepEqual(feed(0.004, 200), [], "a short pause before the minimum");
	assert.deepEqual(feed(0.2, 1_000), []);
	assert.deepEqual(feed(0.004, 400), [300], "the first pause after 10 s ends the chunk");
	assert.deepEqual(feed(0.2, 16_000), [14_900], "speech without a pause: cut at 15 s");
	assert.equal(V.draftClock(402_000).time, "6:42 / 10:00");
	assert.deepEqual(V.draftClock(402_000), { time: "6:42 / 10:00", warn: false, over: false, left: "" });
	assert.deepEqual(V.draftClock(542_500), { time: "9:02 / 10:00", warn: true, over: false, left: "Stops at 10:00, 58 s left. Tap ✓ to finish." });
	assert.equal(V.draftClock(600_000).over, true);
});

// ── a draft's chunks (DraftUplink) against the computer's half (pi-speech PhoneDrafts) ──────────────

/** The fake recogniser hears the audio's bytes as text; the fake drafting model adds each sentence as a point. */
const b64 = (text: string) => Buffer.from(text).toString("base64");
function host() {
	const fast = async (system: string, user: string) => {
		if (system === RECONCILE_SYSTEM) return '{"edits": []}';
		assert.equal(system, DRAFT_SYSTEM);
		const speech = /NEW SPEECH[^\n]*:\n([\s\S]*)$/.exec(user)![1]!;
		return JSON.stringify({ kind: "description", edits: speech.split(/(?<=\.)\s+/).map((text) => ({ op: "add", section: "Requirements", text })) });
	};
	return new PhoneDrafts({
		stt: () => ({ name: "apple" as const, transcribe: async (a: Buffer) => ({ text: a.toString(), provider: "fake" }) }),
		vocabulary: async () => ({ project: "demo", files: [], recent: [], symbols: [] }),
		fast,
		careful: fast,
		dir: () => mkdtempSync(join(tmpdir(), "uplink-")),
	});
}
const METHODS: Record<string, string> = { draftStart: "start", draftChunk: "chunk", draftState: "state", draftFinish: "finish", draftEdit: "edit", draftClose: "close" };
/** web/draft.js's test for "the computer has no such draft". */
const gone = (e: any) => /unknown request|not available|no longer open|no longer connected|can't listen|unavailable/i.test(String(e?.message || e));

/**
 * The phone's link to the computer: `lose` names requests whose reply is lost once (the computer did
 * them); `fail` names requests that fail before reaching it; every request is logged.
 */
function link(h: any, o: { lose?: string[]; fail?: string[] } = {}) {
	const lose = [...(o.lose ?? [])];
	const fail = [...(o.fail ?? [])];
	const log: string[] = [];
	const call = async (m: string, p: any) => {
		log.push(m === "draftChunk" || m === "draftFinish" ? `${m} ${p.seq} ${p.audio ? Buffer.from(p.audio, "base64").toString() : "-"}` : m);
		const f = fail.indexOf(m);
		if (f >= 0) {
			fail.splice(f, 1);
			throw new Error("Failed to fetch");
		}
		const r = await h[METHODS[m]!](p);
		const l = lose.indexOf(m);
		if (l >= 0) {
			lose.splice(l, 1);
			throw new Error("Failed to fetch");
		}
		return r;
	};
	return { call, log };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test("draft chunks: each piece keeps its number; a lost reply is retried alone and heard once; the rest goes under the next number", async () => {
	const h = host();
	const { call, log } = link(h, { lose: ["draftChunk", "draftFinish"] });
	const views: any[] = [];
	const up = new V.DraftUplink({ call, gone, retryMs: 1, params: () => ({ elapsedMs: 40_000 }), onView: (r: any) => views.push(r) });
	up.add(b64("One."));
	await up.sending;
	assert.equal(up.pieces.length, 1, "the reply was lost: the piece waits");
	up.add(b64("Two."));
	await up.sending;
	assert.equal(up.pieces.length, 0);
	assert.deepEqual(log, ["draftStart", "draftChunk 0 One.", "draftChunk 0 One.", "draftChunk 1 Two."], "retried on its own, never merged with newer audio");
	assert.equal(views.at(-1).words, 2, "the computer heard each piece once");
	// Finishing: the rest under the next number; its lost reply is retried under the same number.
	const r = await up.finish(b64("Three."), { elapsedMs: 40_000, draft: true, check: false });
	assert.deepEqual(log.slice(4), ["draftFinish 2 Three.", "draftFinish 2 Three."]);
	assert.equal(r.view.raw, "One. Two. Three.");
	assert.equal(r.view.phase, "ready");
	h.dispose();
});

test("draft chunks: a piece that failed is sent before anything newer, and finishing retries it", async () => {
	const h = host();
	const { call, log } = link(h, { fail: ["draftChunk", "draftChunk"] });
	const up = new V.DraftUplink({ call, gone, retryMs: 1, params: () => ({ elapsedMs: 40_000 }), shown: () => true });
	up.add(b64("One."));
	await up.sending;
	up.add(b64("Two."));
	await up.sending;
	assert.deepEqual(up.pieces.map((p: any) => p.seq), [0, 1], "nothing skipped, nothing merged");
	const r = await up.finish(undefined, { elapsedMs: 40_000, draft: true, check: false });
	assert.deepEqual(log, ["draftStart", "draftChunk 0 One.", "draftChunk 0 One.", "draftChunk 0 One.", "draftChunk 1 Two.", "draftFinish 2 -"]);
	assert.equal(r.view.raw, "One. Two.");
	h.dispose();
});

test("draft chunks: an older pi-mobile without drafts, or one that keeps failing before the draft shows: plain dictation", async () => {
	// An older computer: no draft requests at all.
	let offs = 0;
	const old = new V.DraftUplink({
		call: async (m: string) => {
			throw new Error(`unknown request: ${m}`);
		},
		gone,
		onOff: () => offs++,
	});
	old.add(b64("One."));
	await old.sending;
	assert.equal(old.live, false);
	assert.equal(offs, 1);
	assert.equal(old.add(b64("Two.")), false, "nothing more is kept");
	assert.deepEqual(await old.finish(b64("rest")), { none: true }, "the caller transcribes the whole recording");

	// Three failures in a row before the draft shows: chunking stops and its pieces go; the draft is put away.
	const h = host();
	const { call, log } = link(h, { fail: ["draftChunk", "draftChunk", "draftChunk"] });
	const up = new V.DraftUplink({ call, gone, onOff: () => offs++ });
	for (const w of ["One.", "Two.", "Three."]) {
		up.add(b64(w));
		await up.sending;
	}
	await settle();
	assert.equal(up.off, true);
	assert.equal(up.pieces.length, 0, "no audio kept beyond what the fallback needs (the caller's own recording)");
	assert.equal(offs, 2);
	assert.equal(log.at(-1), "draftClose");
	assert.equal(h.size, 0);
	assert.deepEqual(await up.finish(b64("rest")), { none: true });

	// A computer that can't open drafts at all (draftStart keeps failing) gives up the same way.
	const never = new V.DraftUplink({
		call: async () => {
			throw new Error("Failed to fetch");
		},
		gone,
	});
	for (let i = 0; i < 3; i++) {
		never.add(b64(`${i}.`));
		await never.sending;
	}
	assert.equal(never.off, true);
	assert.equal(never.pieces.length, 0);
});

test("draft chunks: the computer lost a draft that is on screen: finishing says so (the caller transcribes the whole recording)", async () => {
	const h = host();
	const { call } = link(h);
	let offs = 0;
	const up = new V.DraftUplink({ call, gone, shown: () => true, params: () => ({ elapsedMs: 40_000 }), onOff: () => offs++ });
	up.add(b64("One."));
	await up.sending;
	h.dispose(); // pi restarted
	up.add(b64("Two."));
	await up.sending;
	assert.equal(up.lost, true);
	assert.equal(offs, 1);
	assert.deepEqual(await up.finish(b64("Three.")), { lost: true });

	// Lost at the very end: the finish itself finds no draft.
	const h2 = host();
	const l2 = link(h2);
	const up2 = new V.DraftUplink({ call: l2.call, gone, shown: () => true, params: () => ({ elapsedMs: 40_000 }) });
	up2.add(b64("One."));
	await up2.sending;
	h2.dispose();
	assert.deepEqual(await up2.finish(b64("Two."), { draft: true }), { lost: true });
});

test("draft chunks: closed while a request is out: late answers are ignored and a draft opened meanwhile is put away", async () => {
	const h = host();
	const { call, log } = link(h);
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	const slow = async (m: string, p: any) => {
		if (m === "draftStart") await held;
		return call(m, p);
	};
	const seen: string[] = [];
	const up = new V.DraftUplink({ call: slow, gone, onStart: () => seen.push("start"), onView: () => seen.push("view") });
	up.add(b64("One."));
	up.close();
	release();
	await up.sending;
	await settle();
	assert.equal(seen.join(), "", "nobody is told about a closed draft");
	assert.deepEqual(log, ["draftStart", "draftClose"], "the draft opened meanwhile is discarded; no chunk is sent");
	assert.equal(h.size, 0);
	assert.deepEqual(await up.finish(b64("rest")), { closed: true });

	// Closed while a chunk is out: its answer is dropped.
	let chunkOut!: () => void;
	const out = new Promise<void>((r) => (chunkOut = r));
	const up2 = new V.DraftUplink({
		call: async (m: string, p: any) => {
			if (m === "draftChunk") await out;
			return call(m, p);
		},
		gone,
		onView: () => seen.push("view"),
	});
	up2.add(b64("One."));
	await settle();
	up2.close();
	chunkOut();
	await up2.sending;
	assert.equal(seen.join(), "");
	h.dispose();
});

test("Markdown typed on the phone splits into the same blocks the computer keeps", () => {
	const samples = [
		"# Upload retries\nUploads fail;\nwraps here.\n\n\n- Retry three times\n- Log it\n  with the number\n1. first\n\n```ts\nretry(3);\n\ndone();\n```\nTrailing words",
		"Text\n```\ncode\n\n## not a heading",
		"~~~~\n```\nstill code\n~~~~\n## Heading\npara\r\nmore",
		"",
	];
	for (const s of samples) assert.deepEqual(V.markdownBlocks(s).map((b: any) => ({ src: b.src, gap: b.gap })), hostBlocks(s), JSON.stringify(s));
	assert.deepEqual(
		V.markdownBlocks(samples[0]).map((b: any) => b.kind),
		["heading", "para", "item", "item", "item", "para", "para"],
	);
});

test("a thought that trails off keeps the floor", () => {
	assert.equal(V.incomplete("refactor the hub and"), true);
	assert.equal(V.incomplete("so the thing is um"), true);
	assert.equal(V.incomplete("refactor the hub."), false);
});

test("VAD: adaptive floor, minimum speech, hangover and extension", () => {
	const v = new V.Vad({ hangMs: 500, minSpeechMs: 100 });
	let t = 0;
	const run = (rms: number, ms: number) => {
		const evs: string[] = [];
		for (const end = t + ms; t < end; t += 20) {
			const e = v.feed(rms, t);
			if (e) evs.push(e);
		}
		return evs;
	};
	assert.deepEqual(run(0.005, 1000), []);
	assert.deepEqual(run(0.2, 60), [], "a click is not speech");
	assert.deepEqual(run(0.005, 100), []);
	assert.deepEqual(run(0.2, 300), ["start"]);
	assert.deepEqual(run(0.005, 300), [], "a short pause keeps the turn");
	assert.deepEqual(run(0.2, 100), []);
	v.extend(800);
	assert.deepEqual(run(0.005, 900), [], "extended while the words trail off");
	assert.deepEqual(run(0.005, 500), ["end"]);
	v.setGain(10);
	assert.deepEqual(run(0.05, 500), [], "our own voice does not trigger it");
});

test("speech is chunked at sentence and clause boundaries", () => {
	assert.deepEqual(V.chunks("Done. Two tests fail! Want details?"), ["Done.", "Two tests fail!", "Want details?"]);
	const long = `${"word ".repeat(30)}, ${"more ".repeat(30)}`;
	assert.ok(V.chunks(long, 100).every((c: string) => c.length <= 100));
});

test("settings by voice: push to talk, open mic, eyes free, can glance", () => {
	assert.equal(V.parseCommand("Push to talk.")?.kind, "pushToTalk");
	assert.equal(V.parseCommand("open mic")?.kind, "openMic");
	assert.equal(V.parseCommand("I'm driving")?.kind, "eyesFree");
	assert.equal(V.parseCommand("I can glance")?.kind, "glance");
	assert.equal(V.parseCommand("push the branch to talk"), null);
	assert.ok(V.SETTINGS.includes("pushToTalk"));
});

test("switching by voice: names, the computer's name, and asking when two computers fit", () => {
	const list = [
		{ agent: "1", name: "api", cwd: "/Users/you/work/api", task: "fix totals", machine: "laptop" },
		{ agent: "2", name: "api", cwd: "/home/you/api", task: "deploy", machine: "hetzner box" },
		{ agent: "3", name: "web", cwd: "/Users/you/work/web", task: "settings page", machine: "laptop" },
	];
	assert.equal(V.matchSession(list, "web").match.agent, "3");
	assert.equal(V.matchSession(list, "the api session on the box").match.agent, "2");
	assert.equal(V.matchSession(list, "api on the laptop").match.agent, "1");
	assert.deepEqual(V.matchSession(list, "api").ambiguous.map((x: any) => x.agent), ["1", "2"]);
	assert.equal(V.matchSession(list, "hetzner").match.agent, "2", "a computer with one session is enough");
	assert.ok(V.matchSession(list, "billing").none);
	// One computer: no machine names, behaves as before.
	const one = list.map((x) => ({ ...x, machine: "" })).slice(0, 1).concat([{ agent: "3", name: "web", cwd: "/w/web", task: "", machine: "" }]);
	assert.equal(V.matchSession(one, "switch to web").match.agent, "3");
});
