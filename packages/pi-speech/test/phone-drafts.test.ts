// Long dictation from the phone: chunks recognised on the computer, the terminal's drafting engine,
// the draft (and what changed) back to the phone. Fake recogniser and fake models.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRAFT_SYSTEM, RECONCILE_SYSTEM } from "../src/drafting.ts";
import { VoiceHost } from "../src/host.ts";
import type { Complete } from "../src/model.ts";
import { MAX_CHUNK, MAX_RECORDING, PhoneDrafts } from "../src/phone-drafts.ts";

/** The fake recogniser hears the audio's bytes as text. */
const audio = (text: string) => Buffer.from(text).toString("base64");
const stt = () => ({ name: "apple" as const, transcribe: async (a: Buffer) => ({ text: a.toString(), provider: "fake" }) });
const vocab = async () => ({ project: "demo", files: ["src/upload.ts"], recent: [], symbols: ["uploadPhoto"] });

/** Live updates add each sentence of NEW SPEECH as a requirement; the check restores a point; changes remove one. */
function models(log: string[] = []) {
	const fast: Complete = async (system, user) => {
		if (system === DRAFT_SYSTEM) {
			const speech = /NEW SPEECH[^\n]*:\n([\s\S]*)$/.exec(user)![1]!;
			if (/drop the point about logs/i.test(speech)) {
				log.push("change");
				const id = /\[(p\d+)\] - Log every retry/.exec(user)![1];
				return JSON.stringify({ edits: [{ op: "remove", id }] });
			}
			log.push(`update: ${speech}`);
			const points = speech.split(/(?<=\.)\s+/).filter((s) => s.trim());
			return JSON.stringify({ kind: "description", shape: "spec", title: "Upload retries", edits: points.map((text) => ({ op: "add", section: "Requirements", text: text.replace(/\.$/, "") })) });
		}
		if (system === RECONCILE_SYSTEM) {
			log.push("check (fast)");
			return '{"edits": []}';
		}
		throw new Error("unexpected prompt");
	};
	const careful: Complete = async (system, user) => {
		assert.equal(system, RECONCILE_SYSTEM);
		assert.match(user, /TRANSCRIPT \(everything the developer said, in order\):\n[\s\S]*Retry uploads three times/);
		log.push("check");
		return JSON.stringify({ edits: [{ op: "add", section: "Also mentioned", text: "Mention the retry cap in the docs" }] });
	};
	return { fast, careful };
}

function drafts(over: Partial<ConstructorParameters<typeof PhoneDrafts>[0]> = {}, log: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "phone-drafts-"));
	const m = models(log);
	return { dir, d: new PhoneDrafts({ stt, vocabulary: vocab, fast: m.fast, careful: m.careful, dir: () => dir, ...over }) };
}

const until = async (f: () => boolean, ms = 2000) => {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
};

test("phone drafts: chunk → transcript on disk → draft updated → the changed blocks, then the check on finish", async () => {
	const log: string[] = [];
	const { d, dir } = drafts({}, log);
	const s0 = await d.start();
	assert.equal(s0.isDraft, false);
	assert.equal(s0.maxMs, 10 * 60_000);
	assert.equal(s0.warnMs, 9 * 60_000);

	// First chunk: the words are back at once (the Hearing line); the update follows.
	const said = "Retry uploads three times. Show a progress bar while each upload runs.";
	const c1 = await d.chunk({ id: s0.id, seq: 0, audio: audio(said), mime: "audio/wav", elapsedMs: 12_000, since: s0.version });
	assert.equal(c1.words, 12);
	assert.equal(c1.hearing, said);
	assert.equal(c1.isDraft, false, "12 s and no update yet: not a draft");
	const file = join(dir, readdirSync(dir)[0]!);
	assert.equal(readFileSync(file, "utf8"), `${said}\n`, "the transcript is on disk before any model answers");

	const u1 = await d.state({ id: s0.id, since: c1.version, wait: true });
	assert.equal(u1.hearing, "", "drafted words leave the Hearing line");
	assert.equal(u1.isDraft, true, "the first update found a description");
	assert.equal(u1.title, "Upload retries");
	assert.deepEqual(
		u1.blocks.map((b) => [b.src, !!b.changed]),
		[
			["## Requirements", true],
			["- Retry uploads three times", true],
			["- Show a progress bar while each upload runs", true],
		],
	);
	assert.equal(u1.markdown, "## Requirements\n\n- Retry uploads three times\n- Show a progress bar while each upload runs");

	// Second chunk: only the new point glows for a phone that saw the first update.
	const c2 = await d.chunk({ id: s0.id, seq: 1, audio: audio("Log every retry attempt."), elapsedMs: 24_000, since: u1.version });
	assert.equal(c2.hearing, "Log every retry attempt.");
	const u2 = await d.state({ id: s0.id, since: c2.version, wait: true });
	assert.deepEqual(u2.blocks.filter((b) => b.changed).map((b) => b.src), ["- Log every retry attempt"]);
	// A retried chunk (its reply was lost) is not heard twice.
	await d.chunk({ id: s0.id, seq: 1, audio: audio("Log every retry attempt."), elapsedMs: 24_000 });
	await assert.rejects(d.chunk({ id: s0.id, seq: 5, audio: audio("x") }), /missing/);

	// Finish: the last words, then the check on the session's model; its correction glows too.
	const f = await d.finish({ id: s0.id, seq: 2, audio: audio("Docs need an offline section."), elapsedMs: 31_000, since: u2.version });
	assert.equal(f.phase, "ready");
	assert.equal(f.checked, 1);
	assert.equal(f.note, "Checked against everything you said: 1 correction.", "a section heading that came with it isn't counted");
	assert.deepEqual(log, [`update: ${said}`, "update: Log every retry attempt.", "update: Docs need an offline section.", "check"]);
	assert.deepEqual(
		f.blocks.filter((b) => b.changed).map((b) => b.src),
		["- Docs need an offline section", "## Also mentioned", "- Mention the retry cap in the docs"],
	);
	assert.equal(f.raw, `${said} Log every retry attempt. Docs need an offline section.`);
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);

	// Refining by voice: a change that glows; then by text: typed blocks never glow.
	const e = await d.edit({ id: s0.id, audio: audio("Drop the point about logs."), since: f.version });
	assert.equal(e.heard, "Drop the point about logs.");
	assert.deepEqual(
		e.blocks.filter((b) => b.removed).map((b) => b.src),
		["- Log every retry attempt"],
	);
	assert.doesNotMatch(e.markdown, /Log every retry/);
	assert.match(readFileSync(file, "utf8"), /\(changing the draft by voice\)\nDrop the point about logs\./);
	const typed = await d.edit({ id: s0.id, markdown: `${e.markdown}\n- Typed by hand`, since: e.version });
	assert.equal(typed.blocks.filter((b) => b.changed || b.removed).length, 0);
	assert.match(typed.markdown, /- Typed by hand$/);
	await assert.rejects(d.chunk({ id: s0.id, seq: 3, audio: audio("more") }), /finished/);

	// Sent: the transcript goes; the session too.
	assert.deepEqual(d.close({ id: s0.id, how: "sent" }), { ok: true, transcriptKept: false });
	assert.equal(existsSync(file), false);
	assert.equal(d.size, 0);
	await assert.rejects(d.state({ id: s0.id }), /no longer open/);
});

test("phone drafts: a short request isn't a draft; kept drafts keep their transcript; limits", async () => {
	const requestOnly: Complete = async (system, user) => {
		if (system !== DRAFT_SYSTEM) throw new Error("no check expected");
		const speech = /NEW SPEECH:\n([\s\S]*)$/.exec(user)![1]!;
		return JSON.stringify({ kind: "request", edits: [{ op: "add", section: "Goal", text: speech }] });
	};
	const { d, dir } = drafts({ fast: requestOnly, careful: requestOnly });
	const a = await d.start();
	await d.chunk({ id: a.id, seq: 0, audio: audio("Rename the upload helper to uploadPhoto please."), elapsedMs: 12_000 });
	const f = await d.finish({ id: a.id, elapsedMs: 14_000 });
	assert.equal(f.isDraft, false, "short, and a request: it stays a prompt");
	assert.equal(f.raw, "Rename the upload helper to uploadPhoto please.");
	assert.equal(readdirSync(dir).length, 0, "a prompt's transcript was only the safety net");
	assert.equal(d.size, 0);

	// A long request: between chunks, the phone's clock passing 30 s makes it a draft (the computer decides).
	const long = await d.start();
	const words = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ");
	const c1 = await d.chunk({ id: long.id, seq: 0, audio: audio(`Please rename these: ${words}.`), elapsedMs: 15_000 });
	assert.equal(c1.isDraft, false);
	assert.equal(c1.draftAfterMs, 30_000);
	assert.equal((await d.state({ id: long.id, since: c1.version, elapsedMs: 31_000 })).isDraft, true);
	d.close({ id: long.id, how: "discard" });

	// The phone already shows a draft (or the user keeps it as text while recording): draft: true, no check.
	const b = await d.start();
	const f2 = await d.finish({ id: b.id, seq: 0, audio: audio("Make the queue survive restarts."), elapsedMs: 40_000, draft: true, check: false });
	assert.equal(f2.isDraft, true);
	assert.equal(f2.phase, "ready");
	assert.match(f2.markdown, /Make the queue survive restarts/);
	assert.deepEqual(d.close({ id: b.id, how: "kept" }), { ok: true, transcriptKept: true });
	assert.equal(readdirSync(dir).length, 1, "kept as text: the transcript stays (7 days)");

	// Size and time limits.
	const c = await d.start();
	await assert.rejects(d.chunk({ id: c.id, seq: 0, audio: Buffer.alloc(MAX_CHUNK + 1).toString("base64") }), /too large/);
	// The last piece, or a whole recording from the iPhone app, may be as long as a `transcribe` recording.
	await assert.rejects(d.finish({ id: c.id, seq: 0, audio: Buffer.alloc(MAX_RECORDING + 1).toString("base64") }), /recording too long/);
	await assert.rejects(d.chunk({ id: c.id, seq: 0 }), /no audio/);
	await assert.rejects(d.chunk({ id: c.id, seq: 0, audio: audio("late"), elapsedMs: 11 * 60_000 }), /10-minute limit/);
	await assert.rejects(d.edit({ id: c.id, markdown: "x" }), /still forming/);
	await assert.rejects(d.chunk({ id: "nope", seq: 0, audio: audio("x") }), /no longer open/);
	d.dispose();
});

test("phone drafts: one update in flight; words that arrive meanwhile go in the next one", async () => {
	let release!: () => void;
	const calls: string[] = [];
	const slow: Complete = async (_system, user) => {
		const speech = /NEW SPEECH:\n([\s\S]*)$/.exec(user)![1]!;
		calls.push(speech);
		if (calls.length === 1) await new Promise<void>((r) => (release = r));
		return JSON.stringify({ kind: "description", edits: [{ op: "add", section: "Requirements", text: speech }] });
	};
	const { d } = drafts({ fast: slow });
	const s = await d.start();
	const c1 = await d.chunk({ id: s.id, seq: 0, audio: audio("First point about the queue."), elapsedMs: 10_000 });
	assert.equal(c1.updating, true);
	const c2 = await d.chunk({ id: s.id, seq: 1, audio: audio("Second point about retries."), elapsedMs: 20_000 });
	assert.equal(c2.hearing, "First point about the queue. Second point about retries.", "not in the draft yet");
	assert.equal(calls.length, 1, "never two updates at once");
	release();
	await until(() => calls.length === 2);
	assert.equal(calls[1], "Second point about retries.");
	const v = await d.state({ id: s.id, since: c2.version, wait: true });
	assert.ok(v.version > c2.version);
	d.dispose();
});

test("voice host: draft requests share the host's recogniser, vocabulary and drafts folder", async () => {
	const state = mkdtempSync(join(tmpdir(), "host-drafts-"));
	const m = models();
	const ctx: any = { cwd: "/tmp/not-a-repo-pi-mobile", sessionManager: { getBranch: () => [] }, modelRegistry: {} };
	const h = new VoiceHost({ ctx: () => ctx, config: () => ({}), stateDir: () => state, complete: m.fast, careful: m.careful, stt, credentials: async () => undefined });
	const s = await h.drafts.start();
	await h.drafts.chunk({ id: s.id, seq: 0, audio: audio("Retry uploads three times. Show the progress of every upload in the list."), elapsedMs: 14_000 });
	assert.equal(readdirSync(join(state, "drafts")).length, 1, "the terminal's drafts folder");
	const f = await h.drafts.finish({ id: s.id, elapsedMs: 32_000 });
	assert.equal(f.isDraft, true);
	assert.match(f.markdown, /Retry uploads three times/);
	h.drafts.close({ id: s.id, how: "sent" });
	assert.equal(readdirSync(join(state, "drafts")).length, 0);
});

test("phone drafts: each piece is heard once by its number: a lost reply's retry, a duplicate, a failed recognition", async () => {
	let failNext = false;
	const flaky = () => ({
		name: "apple" as const,
		transcribe: async (a: Buffer) => {
			if (failNext) {
				failNext = false;
				throw new Error("recogniser busy");
			}
			return { text: a.toString(), provider: "fake" };
		},
	});
	const { d } = drafts({ stt: flaky });
	const s = await d.start();
	await d.chunk({ id: s.id, seq: 0, audio: audio("One."), elapsedMs: 10_000 });
	// The reply to piece 0 was lost: the phone sends piece 0 again, on its own, then piece 1.
	await d.chunk({ id: s.id, seq: 0, audio: audio("One."), elapsedMs: 10_000 });
	const c1 = await d.chunk({ id: s.id, seq: 1, audio: audio("Two."), elapsedMs: 20_000 });
	assert.equal(c1.words, 2, "the retry isn't heard twice, the new piece is heard");
	// Two copies of one piece at once (a retry racing the original): heard once.
	await Promise.all([d.chunk({ id: s.id, seq: 2, audio: audio("Three."), elapsedMs: 30_000 }), d.chunk({ id: s.id, seq: 2, audio: audio("Three."), elapsedMs: 30_000 })]);
	// A piece the recogniser failed on isn't counted: its retry is heard.
	failNext = true;
	await assert.rejects(d.chunk({ id: s.id, seq: 3, audio: audio("Four."), elapsedMs: 40_000 }), /recogniser busy/);
	await assert.rejects(d.chunk({ id: s.id, seq: 4, audio: audio("Five.") }), /missing/, "nothing is skipped");
	await d.chunk({ id: s.id, seq: 3, audio: audio("Four."), elapsedMs: 40_000 });
	// The rest goes with finish under the next number; finish retried after a lost reply hears it once.
	const p = { id: s.id, seq: 4, audio: audio("Five."), elapsedMs: 45_000, draft: true, check: false };
	const f1 = await d.finish(p);
	const f2 = await d.finish(p);
	assert.equal(f1.raw, "One. Two. Three. Four. Five.");
	assert.equal(f2.raw, f1.raw);
	d.dispose();
});

test("phone drafts: Markdown typed on the phone is kept verbatim (what Send uses) until a change by voice", async () => {
	const { d } = drafts();
	const s = await d.start();
	await d.chunk({ id: s.id, seq: 0, audio: audio("Retry uploads three times. Log every retry attempt."), elapsedMs: 12_000 });
	const f = await d.finish({ id: s.id, elapsedMs: 35_000, draft: true });
	const typed = [
		"# Upload retries",
		"Uploads fail on flaky networks;",
		"this paragraph wraps over two lines.",
		"",
		"",
		"- Retry uploads three times",
		"- Log every retry attempt",
		"  with the attempt number",
		"1. first",
		"",
		"```ts",
		"retry(3);",
		"",
		"done();",
		"```",
		"Trailing words",
	].join("\n");
	const e = await d.edit({ id: s.id, markdown: typed, since: f.version });
	assert.equal(e.markdown, typed, "round trip: exactly as typed");
	assert.equal(e.blocks.filter((b) => b.changed).length, 0, "typing never glows");
	assert.deepEqual(
		e.blocks.map((b) => [b.kind, b.src]),
		[
			["heading", "# Upload retries"],
			["para", "Uploads fail on flaky networks;\nthis paragraph wraps over two lines."],
			["item", "- Retry uploads three times"],
			["item", "- Log every retry attempt\n  with the attempt number"],
			["item", "1. first"],
			["para", "```ts\nretry(3);\n\ndone();\n```"],
			["para", "Trailing words"],
		],
	);
	// Typing again with nothing changed by voice: still verbatim; unchanged blocks keep their ids.
	const again = await d.edit({ id: s.id, markdown: `${typed}\n`, since: e.version });
	assert.equal(again.markdown, `${typed}\n`);
	assert.deepEqual(
		again.blocks.map((b) => b.id),
		e.blocks.map((b) => b.id),
	);
	// A change by voice: the drafting engine's Markdown from then on.
	const v = await d.edit({ id: s.id, audio: audio("Drop the point about logs."), since: again.version });
	assert.notEqual(v.markdown, typed);
	assert.doesNotMatch(v.markdown, /Log every retry/);
	assert.match(v.markdown, /this paragraph wraps over two lines\./);
	d.dispose();
});

test("phone drafts: dispose drops every draft, cancels the check in flight, and can be called twice", async () => {
	// Stuck in the last update, or in the check; a model that ignores the cancel never answers at all.
	for (const [stuck, ignoresAbort] of [
		["update", false],
		["check", false],
		["check", true],
	] as const) {
		let asked!: () => void;
		const askedP = new Promise<void>((r) => (asked = r));
		const calls: string[] = [];
		const hanging: Complete = async (system, _user, opts) => {
			calls.push(system === RECONCILE_SYSTEM ? "check" : "update");
			asked();
			return new Promise((_, reject) => {
				if (!ignoresAbort) opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		};
		const m = models();
		const { d } = drafts(stuck === "update" ? { careful: hanging, fast: hanging } : { careful: hanging, fast: m.fast });
		const s = await d.start();
		const waiting = d.state({ id: s.id, since: 99, wait: true });
		const finishing = d.finish({ id: s.id, seq: 0, audio: audio("Retry uploads three times. Make the queue survive restarts."), elapsedMs: 40_000, draft: true });
		await askedP;
		assert.deepEqual(calls, [stuck], stuck);
		const t0 = Date.now();
		d.dispose();
		d.dispose();
		assert.equal(d.size, 0);
		await finishing;
		await waiting;
		assert.ok(Date.now() - t0 < 1000, "the model call and the waiting request end at once");
		assert.deepEqual(calls, [stuck], "nothing more is asked of a model once the drafts are gone");
		await assert.rejects(d.start(), /not available/, "the phone dictates as before");
		await assert.rejects(d.chunk({ id: s.id, seq: 1, audio: audio("x") }), /no longer open/);
	}
});
