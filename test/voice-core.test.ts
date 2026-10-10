// The phone's voice logic (web/voice-core.js), loaded the way the browser loads it.

import assert from "node:assert/strict";
import { test } from "node:test";

// A browser script, not a module: importing runs it and it sets globalThis.PiVoiceCore.
const script = "../web/voice-core.js";
await import(script);
const V = (globalThis as any).PiVoiceCore;

test("short utterances are instant local commands; longer ones go to pi", () => {
	assert.deepEqual(V.parseCommand("Stop!"), { kind: "stop" });
	assert.deepEqual(V.parseCommand("pi, stop"), { kind: "stop" });
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
	assert.match(V.HELP, /stop/);
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
