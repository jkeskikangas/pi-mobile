// Long dictation: drafts made of section edits, the draft view, the transcript on disk, and when a
// dictation becomes a draft.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Draft, namedShape, parseUpdate } from "../src/draft.ts";
import { DraftView, GLOW_STEP_MS, REMOVED_MS, tail, type ViewStatus } from "../src/draft-view.ts";
import {
	becomesDraft,
	Drafter,
	latestTranscript,
	MAX_MS,
	newSpeech,
	pruneTranscripts,
	reconcile,
	requestUpdate,
	stopReason,
	TranscriptFile,
} from "../src/drafting.ts";

initTheme("dark", false);

const DOC = `## Goal
Make uploads survive flaky networks.

## Requirements
- Exponential backoff on upload
- Fix the flaky upload test

## Open questions
1. Should the cap apply to downloads too?`;

const id = (d: Draft, text: string) => `p${d.live().find((b) => b.src.includes(text))!.id}`;

test("model output: JSON in fences or prose, trailing commas and op aliases are read; junk edits are dropped", () => {
	const u = parseUpdate(
		'Here you go:\n```json\n{"kind":"description","shape":"Spec","title":"Upload retries","edits":[{"op":"add_point","section":"requirements","text":"- Cap at 3 retries"},{"op":"delete","id":"p2"},{"op":"change","text":"no target"},{"op":"frobnicate"},{"type":"answer","id":"[p7]","answer":"Yes"},],}\n```\nDone.',
	);
	assert.equal(u.ok, true);
	assert.equal(u.kind, "description");
	assert.equal(u.shape, "spec");
	assert.equal(u.title, "Upload retries");
	assert.deepEqual(u.edits, [
		{ op: "add", section: "Requirements", text: "Cap at 3 retries" },
		{ op: "remove", id: "p2", match: undefined },
		{ op: "resolve", id: "[p7]", match: undefined, section: undefined, text: "Yes" },
	]);
	assert.deepEqual(parseUpdate('[{"op":"add","section":"Also mentioned","text":"Docs"}]').edits, [{ op: "add", section: "Also mentioned", text: "Docs" }]);
	assert.equal(parseUpdate("I can't help with that.").ok, false);
	assert.equal(parseUpdate('{"edits": [').ok, false);
	assert.deepEqual(parseUpdate('{"edits": []}'), { edits: [], kind: undefined, shape: undefined, shapeNamed: false, title: undefined, ok: true });
});

test("section edits are applied as given: add, change, move, remove, resolve, in a stable order", () => {
	const d = new Draft(DOC);
	const before = d.live().map((b) => b.id);
	const changed = d.apply(
		{
			edits: [
				{ op: "add", section: "Requirements", text: "Show the time until the next retry" },
				{ op: "change", id: id(d, "Exponential"), text: "Exponential backoff on upload, capped at 3 retries", note: "You first said 5, later 3; kept 3." },
				{ op: "add", section: "Also mentioned", text: "Docs need a section on offline use" },
				{ op: "move", id: id(d, "flaky upload test"), section: "Also mentioned" },
				{ op: "resolve", id: id(d, "downloads"), section: "Requirements", text: "The cap applies to downloads too" },
				{ op: "remove", id: "p999" }, // unknown: ignored
				{ op: "add", section: "Requirements", text: "show the time until the next retry." }, // duplicate: ignored
			],
		},
		1000,
	);
	assert.equal(
		d.markdown(),
		`## Goal

Make uploads survive flaky networks.

## Requirements

- Exponential backoff on upload, capped at 3 retries *(You first said 5, later 3; kept 3.)*
- Show the time until the next retry
- The cap applies to downloads too

## Also mentioned

- Docs need a section on offline use
- Fix the flaky upload test`,
	);
	// Exactly the edited blocks changed; the goal and its heading kept their ids.
	const glowing = d.blocks.filter((b) => b.changedAt === 1000).map((b) => b.src);
	assert.deepEqual(glowing.sort(), [
		"## Also mentioned",
		"- Docs need a section on offline use",
		"- Exponential backoff on upload, capped at 3 retries *(You first said 5, later 3; kept 3.)*",
		"- Fix the flaky upload test",
		"- Show the time until the next retry",
		"- The cap applies to downloads too",
	]);
	assert.equal(d.live()[0]!.id, before[0]);
	// The resolved question and its empty section are struck through, then pruned.
	const removed = d.blocks.filter((b) => b.removedAt === 1000).map((b) => b.src);
	assert.deepEqual(removed, ["## Open questions", "1. Should the cap apply to downloads too?"]);
	assert.ok(changed.length >= 8);
	d.prune(1000 + REMOVED_MS, REMOVED_MS);
	assert.equal(d.blocks.filter((b) => b.removedAt !== undefined).length, 0);
});

test("new sections take their place by shape; questions and tangents stay last; numbering follows", () => {
	const d = new Draft();
	d.shape = "spec";
	d.apply({ edits: [{ op: "add", section: "also mentioned", text: "A tangent" }] }, 1);
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "R1" }] }, 2);
	d.apply({ edits: [{ op: "add", section: "Open Questions:", text: "Q1?" }, { op: "add", section: "Open questions", text: "Q2?" }] }, 3);
	d.apply({ edits: [{ op: "add", section: "Goal", text: "The goal." }, { op: "add_section", section: "Context", points: ["Some context"] }] }, 4);
	assert.deepEqual(
		d.sections().map((s) => s.name),
		["Goal", "Context", "Requirements", "Open questions", "Also mentioned"],
	);
	d.apply({ edits: [{ op: "remove", match: "Q1" }] }, 5);
	assert.match(d.markdown(), /## Open questions\n\n1\. Q2\?/);
	// A point cut off mid-sentence and then added in full is replaced, not duplicated.
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Big photos upload in chunks of 5." }] }, 7);
	const cut = d.live().find((b) => b.src.includes("chunks of 5"))!;
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Big photos upload in chunks of 5 megabytes and resume from the last chunk." }] }, 8);
	assert.equal(cut.src, "- Big photos upload in chunks of 5 megabytes and resume from the last chunk.");
	assert.equal(cut.changedAt, 8);
	assert.equal(d.live().filter((b) => b.src.includes("chunks of 5")).length, 1);
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Big photos upload in chunks" }] }, 9);
	assert.equal(d.live().filter((b) => b.src.includes("chunks")).length, 1, "a shorter repeat adds nothing");
	// A change by text match, when the model forgot the id.
	d.apply({ edits: [{ op: "change", match: "some context", text: "Other context" }] }, 6);
	assert.match(d.markdown(), /- Other context/);
});

test("the shape the speaker names wins over the model's guess, and keeps winning", async () => {
	assert.equal(namedShape("okay so make this a spec please"), "spec");
	assert.equal(namedShape("let's turn it into a task list"), "task list");
	assert.equal(namedShape("the spec says retries are capped"), undefined);
	assert.equal(namedShape("Oh, and make this a speck."), "spec", "as the recogniser heard it");
	const d = new Draft();
	const guess = (shape: string) => async () => JSON.stringify({ shape, edits: [{ op: "add", section: "Requirements", text: `from ${shape}` }] });
	d.apply(await requestUpdate(guess("prompt"), d, "retry uploads, and make this a spec"), 1);
	assert.equal(d.shape, "spec");
	assert.equal(d.shapeNamed, true);
	d.apply(await requestUpdate(guess("task list"), d, "also fix the test"), 2);
	assert.equal(d.shape, "spec");
});

// ── the view ──

const fakeTheme = (mode: "truecolor" | "256color" = "truecolor") =>
	({
		colors: { userMessageBg: rgbColor(40, 40, 40), accent: rgbColor(0, 160, 255) },
		getColorMode: () => mode,
		fg: (_c: string, t: string) => `\x1b[38;5;1m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
		italic: (t: string) => t,
		strikethrough: (t: string) => `\x1b[9m${t}\x1b[29m`,
	}) as any;

function fakeTui(rows: number, footer?: unknown) {
	return { terminal: { rows, columns: 80 }, children: footer === undefined ? [] : [{ render: () => [""] }, footer], requestRender() {}, addInputListener: () => () => {} } as any;
}

function view(draft: Draft, opts: { rows?: number; footer?: unknown; reducedMotion?: boolean; status?: Partial<ViewStatus>; clock?: { t: number } } = {}) {
	const clock = opts.clock ?? { t: 0 };
	const tui = fakeTui(opts.rows ?? 30, opts.footer ?? { render: (w: number) => ["FOOTER pwd".padEnd(w), "FOOTER model".padEnd(w)] });
	const v = new DraftView(tui, fakeTheme(), draft, {
		status: () => ({ state: "listening", elapsedMs: 65_000, ...opts.status }),
		onEnter() {},
		onEscape() {},
		onAltM() {},
		now: () => clock.t,
		reducedMotion: opts.reducedMotion,
		markdownTheme: getMarkdownTheme(),
		animate: false,
	});
	return { v, tui, clock };
}

const glowOf = (v: DraftView, line: string) => v.glowSteps.findIndex((bg) => line.includes(bg));

test("the glow marks exactly the lines dictation changed, fades step by step, and never marks typing", () => {
	const d = new Draft(DOC);
	const { v, clock } = view(d);
	clock.t = 10_000;
	const ids = d.apply({ edits: [{ op: "change", id: id(d, "Exponential"), text: "Exponential backoff on upload, capped at 3 retries" }] }, clock.t);
	v.dictated(ids);
	const at = (t: number) => {
		clock.t = t;
		return v.bodyLines(76).map((l) => ({ ...l, glow: glowOf(v, l.text) }));
	};
	const changedId = ids[0];
	for (const [t, step] of [
		[10_000, 0],
		[10_000 + GLOW_STEP_MS + 10, 1],
		[10_000 + 2 * GLOW_STEP_MS + 10, 2],
		[10_000 + 3 * GLOW_STEP_MS + 10, -1],
	] as const) {
		const lines = at(t);
		for (const l of lines) assert.equal(l.glow, l.blockId === changedId ? step : -1, `${t}: ${stripTerminalSequences(l.text)}`);
		assert.ok(lines.some((l) => l.blockId === changedId));
	}
	// A glowing line is painted to the full width, past the resets inside it.
	const full = at(10_000).find((l) => l.blockId === changedId)!;
	assert.equal(visibleWidth(full.text), 76);

	// Typing never glows: the typed block has no glow, even right after a dictated change to it.
	clock.t = 20_000;
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Typed into next" }] }, clock.t);
	// The cursor appears on the last block (the open question), then moves up past its heading.
	for (let i = 0; i < 3; i++) v.handleInput("\x1b[A");
	v.handleInput("!");
	const typed = d.live().find((b) => b.src.includes("Typed into next!"))!;
	assert.equal(typed.changedAt, undefined);
	assert.equal(
		at(20_000).filter((l) => l.glow >= 0).length,
		0,
		"nothing glows after typing into the only glowing block",
	);
	// The block under the cursor shows its source; the others stay rendered.
	const plain = at(20_000).map((l) => stripTerminalSequences(l.text));
	assert.ok(plain.some((l) => l.includes("- Typed into next!")));
	assert.ok(plain.some((l) => l.includes("Goal") && !l.includes("##")));
});

test("removed text is struck through for two seconds, then gone", () => {
	const d = new Draft(DOC);
	const { v, clock } = view(d);
	clock.t = 5000;
	d.apply({ edits: [{ op: "remove", id: id(d, "flaky upload test") }] }, clock.t);
	const struck = v.bodyLines(76).filter((l) => l.text.includes("\x1b[9m"));
	assert.equal(struck.length, 1);
	assert.match(stripTerminalSequences(struck[0]!.text), /Fix the flaky upload test/);
	clock.t = 5000 + REMOVED_MS;
	assert.ok(!v.bodyLines(76).some((l) => stripTerminalSequences(l.text).includes("flaky upload test")));
});

test("without motion, changed lines get a margin mark until the next key", () => {
	const d = new Draft(DOC);
	const { v, clock } = view(d, { reducedMotion: true });
	assert.equal(v.motion, false);
	clock.t = 1000;
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Marked point" }] }, clock.t);
	clock.t = 60_000; // long after a glow would have faded
	const rows = v.render(80);
	assert.ok(rows.some((r) => r.includes("▎") && stripTerminalSequences(r).includes("Marked point")));
	assert.ok(!rows.some((r) => r.includes("▎") && stripTerminalSequences(r).includes("Make uploads")));
	assert.ok(!rows.some((r) => v.glowSteps.some((g) => r.includes(g))));
	v.handleInput("\x1b[6~"); // PgDn: any key clears the marks
	assert.ok(!v.render(80).some((r) => r.includes("▎")));
});

test("the view fills exactly the terminal's rows, with pi's footer at the bottom", () => {
	const d = new Draft(DOC);
	for (const rows of [40, 24, 12, 6]) {
		const { v } = view(d, { rows, status: { hearing: "and the error message should say how long until the next retry happens" } });
		const out = v.render(80);
		assert.equal(out.length, rows, `rows ${rows}`);
		assert.equal(out[rows - 2], "FOOTER pwd".padEnd(80));
		assert.equal(out[rows - 1], "FOOTER model".padEnd(80));
		for (const l of out) assert.ok(visibleWidth(l) <= 80);
		assert.match(stripTerminalSequences(out[0]!), /^ Draft .*1:05/);
	}
	// Resize: the same view follows the new size.
	const { v, tui } = view(d, { rows: 30 });
	assert.equal(v.render(80).length, 30);
	tui.terminal.rows = 18;
	assert.equal(v.render(60).length, 18);
	// No usable footer component: the rows are left empty instead.
	const bare = view(d, { rows: 20, footer: { notAComponent: true } }).v.render(80);
	assert.equal(bare.length, 20);
	assert.equal(bare[19], "");
	// A long draft scrolls; the view shows it can.
	const long = new Draft(DOC);
	for (let i = 0; i < 40; i++) long.apply({ edits: [{ op: "add", section: "Also mentioned", text: `Tangent ${i}` }] }, 0);
	const lv = view(long, { rows: 20 });
	lv.v.dictated([long.live().at(-1)!.id]);
	const shown = lv.v.render(80).map(stripTerminalSequences);
	assert.ok(shown.some((l) => l.includes("Tangent 39")), "follows the latest change");
	assert.ok(shown.some((l) => l.endsWith("↑")));
});

test("the Hearing line keeps the latest words", () => {
	const t = tail("one two three four five six seven eight nine ten", 20);
	assert.ok(t.startsWith("…") && t.endsWith("nine ten") && visibleWidth(t) <= 20, t);
	assert.equal(tail("short", 20), "short");
});

// ── the transcript on disk ──

test("the transcript is written as segments settle, survives a crash, and is pruned after a week", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "pi-speech-drafts-")), "drafts");
	const f = new TranscriptFile(dir, new Date("2026-10-11T10:00:00Z"));
	f.append("So the uploads keep failing.");
	assert.equal(readFileSync(f.path, "utf8"), "So the uploads keep failing.\n");
	f.append("  We need retries. ");
	assert.equal(readFileSync(f.path, "utf8"), "So the uploads keep failing.\nWe need retries.\n");
	// "Crash": a new process finds it.
	assert.deepEqual(latestTranscript(dir), { path: f.path, text: "So the uploads keep failing.\nWe need retries." });
	// The end of the recording adds only what wasn't settled yet.
	f.complete("So the uploads keep failing. We need retries. Capped at three.");
	assert.equal(readFileSync(f.path, "utf8"), "So the uploads keep failing.\nWe need retries.\nCapped at three.\n");
	// Older than a week goes on the next start.
	const old = join(dir, "2026-10-01T10-00-00-000Z.txt");
	writeFileSync(old, "old");
	const weekAgo = (Date.now() - 8 * 86_400_000) / 1000;
	utimesSync(old, weekAgo, weekAgo);
	assert.equal(pruneTranscripts(dir), 1);
	assert.ok(!existsSync(old) && existsSync(f.path));
	f.delete();
	assert.ok(!existsSync(f.path));
	assert.equal(latestTranscript(dir), undefined);
});

// ── drafting ──

test("draft or prompt: length, or a description found early; pauses never stop a draft", () => {
	assert.equal(becomesDraft({ elapsedMs: 12_000, words: 30 }), false, "a short request stays a prompt");
	assert.equal(becomesDraft({ elapsedMs: 12_000, words: 30, kind: "request" }), false);
	assert.equal(becomesDraft({ elapsedMs: 12_000, words: 30, kind: "description" }), true, "a description becomes a draft early");
	assert.equal(becomesDraft({ elapsedMs: 4_000, words: 6, kind: "description" }), false, "but not from a few words");
	assert.equal(becomesDraft({ elapsedMs: 31_000, words: 80 }), true, "30 s of speech");
	assert.equal(becomesDraft({ elapsedMs: 45_000, words: 10 }), false, "mostly silence");
	assert.equal(stopReason({ elapsedMs: 40_000, silentMs: 35_000, heard: false }), "silence", "nothing said");
	assert.equal(stopReason({ elapsedMs: 300_000, silentMs: 120_000, heard: true }), undefined, "thinking is not the end");
	assert.equal(stopReason({ elapsedMs: MAX_MS, silentMs: 0, heard: true }), "limit");
});

test("updates go at pauses or after 15 s of speech, one at a time, with the speech since the last one", async () => {
	const clock = { t: 0 };
	const asked: string[] = [];
	let release!: () => void;
	const complete = async (_s: string, user: string) => {
		asked.push(user.split("NEW SPEECH:\n")[1]!);
		await new Promise<void>((r) => (release = r));
		return JSON.stringify({ kind: "description", edits: [{ op: "add", section: "Requirements", text: `point ${asked.length}` }] });
	};
	const draft = new Draft();
	const applied: number[][] = [];
	const dr = new Drafter({ complete, draft, now: () => clock.t, onUpdate: (ids) => applied.push(ids) });
	dr.heard("so the uploads keep failing on");
	clock.t = 1000;
	assert.equal(dr.tick(), undefined, "still talking");
	clock.t = 1600;
	const first = dr.tick();
	assert.ok(first, "a pause");
	dr.heard("so the uploads keep failing on the train and");
	clock.t = 5000;
	assert.equal(dr.tick(), undefined, "one in flight");
	release();
	await first;
	assert.equal(dr.kind, "description");
	assert.equal(applied.length, 1);
	assert.equal(asked[0], "so the uploads keep failing on");
	// Speech without a pause: an update after 15 s anyway.
	for (let t = 5000; t < 16_500; t += 500) {
		clock.t = t;
		dr.heard(`${dr.heardText} w${t}`);
		assert.equal(dr.tick(), undefined, `t=${t}`);
	}
	clock.t = 20_100;
	dr.heard(`${dr.heardText} more`);
	const second = dr.tick();
	assert.ok(second, "15 s of speech");
	assert.match(asked[1]!, /^the train and w5000/);
	release();
	await second;
	assert.deepEqual(draft.live().map((b) => b.src), ["## Requirements", "- point 1", "- point 2"]);
	// A failing model doesn't lose speech: it is sent again with the next update.
	const flaky = new Drafter({
		complete: async () => {
			throw new Error("offline");
		},
		draft: new Draft(),
		now: () => clock.t,
	});
	flaky.heard("one two three four five");
	clock.t += 2000;
	await flaky.tick();
	assert.equal(flaky.failures, 1);
	assert.equal(flaky.pending(), "one two three four five");
	assert.equal(newSpeech("a b c", "a b c d e"), "d e");
	// Without a pause, an update stops at the last finished sentence and keeps the rest for the next one.
	const held: string[] = [];
	const hd = new Drafter({
		complete: async (_s, u) => (held.push(u), '{"edits": []}'),
		draft: new Draft(),
		now: () => clock.t,
	});
	clock.t = 100_000;
	hd.heard("Upload in chunks. Of five megabytes and");
	for (let t = 100_000; t <= 115_500; t += 500) {
		clock.t = t;
		hd.heard(`${hd.heardText} x`);
		await hd.tick();
	}
	assert.equal(held.length, 1);
	assert.match(held[0]!, /NEW SPEECH:\nUpload in chunks\.$/);
	assert.equal(hd.pending().startsWith("Of five megabytes and"), true);
	clock.t += 2000;
	await hd.tick();
	assert.match(held[1]!, /SAID JUST BEFORE[^\n]*\n…Upload in chunks\.\n\nNEW SPEECH:\nOf five megabytes and x/);
	assert.equal(newSpeech("a b see", "a b c d"), "c d", "the recogniser revised a word");
});

test("with a recogniser that settles segments, updates follow the settled text, with a 15 s backstop", async () => {
	const clock = { t: 0 };
	const asked: string[] = [];
	const dr = new Drafter({
		complete: async (_s, u) => (asked.push(u.split("NEW SPEECH:\n")[1]!), '{"edits": []}'),
		draft: new Draft(),
		now: () => clock.t,
	});
	dr.heard("Uploads keep failing on the train. And we");
	dr.settled("Uploads keep failing on the train.");
	clock.t = 100;
	await dr.tick();
	assert.deepEqual(asked, ["Uploads keep failing on the train."], "only what the recogniser settled");
	// Volatile words alone never trigger an update at a short pause; the next settled segment does.
	dr.heard("Uploads keep failing on the train. And we never tell the user");
	clock.t = 3000;
	assert.equal(dr.tick(), undefined);
	dr.settled("Uploads keep failing on the train. And we never tell the user.");
	await dr.tick();
	assert.equal(asked[1], "And we never tell the user.");
	// Long speech that never settles: the backstop sends the finished sentences after 15 s.
	for (let t = 4000; t <= 19_500; t += 500) {
		clock.t = t;
		dr.heard(`${dr.heardText}${t === 9000 ? " Cap it at three." : ` w${t}`}`);
		await dr.tick();
	}
	assert.equal(asked.length, 3);
	assert.match(asked[2]!, /^w4000 w4500 .* w8500 Cap it at three\.$/);
});

test("the drafting prompts get the workspace's names, as distillation does", async () => {
	const { vocabularyPrompt, updatePrompt, reconcilePrompt } = await import("../src/drafting.ts");
	const v = {
		project: "photo-app",
		branch: "uploads",
		files: ["src/upload/queue.ts", "src/components/CustomerCard.tsx"],
		recent: ["uploadPhoto"],
		symbols: ["getUserById", "CustomerCard"],
		learned: [{ from: "sequel light", to: "SQLite" }],
	};
	const block = vocabularyPrompt("then the get user by id and the customer card", v);
	assert.match(block, /PROJECT: photo-app \(branch uploads\)/);
	assert.match(block, /WORKSPACE NAMES:[\s\S]*getUserById {3}\(maybe heard as "get user by id"\)/);
	assert.match(block, /PROJECT FILES \(1 of 2\):\nsrc\/upload\/queue\.ts/);
	assert.match(block, /PERSONAL DICTIONARY:\n"sequel light" -> SQLite/);
	const d = new Draft(DOC);
	assert.match(updatePrompt(d, "speech", { vocabulary: block }), /WORKSPACE NAMES[\s\S]*CURRENT DRAFT/);
	assert.match(reconcilePrompt(d, "transcript", block), /PERSONAL DICTIONARY[\s\S]*TRANSCRIPT/);
});

test("the finishing check restores a point an update dropped, and leaves typed text alone", async () => {
	const d = new Draft(DOC);
	const typedBlock = d.live().find((b) => b.src.includes("Exponential"))!;
	d.typed(typedBlock, "- Exponential backoff (typed)", 1);
	let prompt = "";
	const careful = async (_s: string, user: string) => {
		prompt = user;
		return JSON.stringify({
			edits: [
				{ op: "add", section: "Requirements", text: "The error message says how long until the next retry" },
				{ op: "change", id: `p${typedBlock.id}`, text: "Exponential backoff" },
			],
		});
	};
	const transcript = "Uploads should survive flaky networks. Use exponential backoff. Fix the flaky upload test. And the error message says how long until the next retry.";
	const ids = await reconcile(careful, d, transcript, () => 7000);
	assert.match(prompt, /TRANSCRIPT[\s\S]*how long until the next retry/);
	assert.match(prompt, /\[p\d+\] - Fix the flaky upload test/);
	const restored = d.live().find((b) => b.src.includes("how long until"))!;
	assert.deepEqual(ids, [restored.id]);
	assert.equal(restored.changedAt, 7000, "the correction glows");
	assert.equal(typedBlock.src, "- Exponential backoff (typed)");
	await assert.rejects(reconcile(async () => "sorry", d, transcript, () => 8000));
});

test("the finishing check keeps an open question unless what was said answers it, and then puts the answer where it belongs", async () => {
	const DRAFT = `## Requirements
- Retry uploads, capped at 3 retries

## Open questions
1. Should the cap apply to downloads too?
2. Which error message should it show?
3. Which error message should it show?

## Also mentioned
- Docs on offline use`;
	const questions = (d: Draft) => d.sections().find((s) => s.name === "Open questions")?.points.map((p) => p.src) ?? [];
	const fake = (edits: unknown[]) => async () => JSON.stringify({ edits });
	const transcript = "Retry uploads, cap it at three. I haven't decided whether the cap applies to downloads. Which error message, not sure yet. Docs on offline use.";

	// Not answered: removing it, moving it to an aside, or "resolving" it without an answer are all refused.
	const d = new Draft(DRAFT);
	const q1 = id(d, "downloads");
	const [q2, q3] = d.live().filter((b) => b.src.includes("error message")).map((b) => `p${b.id}`);
	const ids = await reconcile(
		fake([
			{ op: "remove", id: q1 },
			{ op: "move", id: q1, section: "Also mentioned" },
			{ op: "resolve", id: q1 },
			{ op: "resolve", id: q1, section: "Open questions", text: "Downloads too?" },
			// A duplicate may go, but not both copies.
			{ op: "remove", id: q3 },
			{ op: "remove", id: q2 },
			// Other corrections still apply.
			{ op: "change", id: id(d, "Retry uploads"), text: "Retry uploads, capped at three retries" },
		]),
		d,
		transcript,
		() => 9000,
	);
	assert.deepEqual(questions(d), ["1. Should the cap apply to downloads too?", "2. Which error message should it show?"]);
	assert.match(d.markdown(), /- Retry uploads, capped at three retries/);
	assert.ok(!/Also mentioned[\s\S]*downloads/.test(d.markdown()), "not turned into an aside");
	assert.equal(ids.length, 2, "the duplicate and the change");

	// Answered later in what was said: resolved, the question goes and the answer lands in its section.
	const e = new Draft(DRAFT);
	await reconcile(
		fake([{ op: "resolve", id: id(e, "downloads"), section: "Requirements", text: "The cap applies to downloads too" }]),
		e,
		`${transcript} Actually yes, the cap applies to downloads too.`,
		() => 9000,
	);
	assert.ok(!questions(e).some((q) => q.includes("downloads")));
	assert.match(e.markdown(), /## Requirements\n\n- Retry uploads, capped at 3 retries\n- The cap applies to downloads too/);
	const { RECONCILE_SYSTEM } = await import("../src/drafting.ts");
	assert.match(RECONCILE_SYSTEM, /An open question stays under "Open questions" unless a later statement in the transcript answers it/);
});
