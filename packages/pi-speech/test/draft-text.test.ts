// Drafts as text: typed or pasted Markdown keeps its structure (paragraphs with soft breaks, lists,
// code fences) and round-trips exactly; the view's paste, empty-draft typing and redraw cadence;
// long speech drafted in pieces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Draft, markdownBlocks } from "../src/draft.ts";
import { DraftView, GLOW_STEP_MS, type ViewStatus } from "../src/draft-view.ts";
import { Drafter, DRAFT_SYSTEM, MAX_UPDATE_WORDS, TranscriptFile } from "../src/drafting.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

initTheme("dark", false);

const TYPED = `# Upload retries

Uploads fail on the train.
They should retry, quietly,
and tell the user only at the end.

## Requirements
- Exponential backoff
  capped at three tries
- Keep the queue on disk

1. First
2. Second

Run it like this:

\`\`\`sh
npm test

npm run typecheck
\`\`\`

~~~
raw ~~~ text
~~~
After the fence, no blank line.
> A quote
> on two lines

| a | b |
|---|---|
| 1 | 2 |`;

test("typed Markdown round-trips: soft breaks, lists, fences and spacing stay as typed", () => {
	const d = Draft.fromMarkdown(TYPED);
	assert.equal(d.markdown(), TYPED);
	const srcs = d.live().map((b) => b.src);
	assert.ok(srcs.includes("Uploads fail on the train.\nThey should retry, quietly,\nand tell the user only at the end."), "a paragraph is one block");
	assert.ok(srcs.includes("- Exponential backoff\n  capped at three tries"), "an item keeps its continuation");
	assert.ok(srcs.includes("```sh\nnpm test\n\nnpm run typecheck\n```"), "a fence is whole, blank line and all");
	assert.ok(srcs.includes("~~~\nraw ~~~ text\n~~~"));
	assert.ok(srcs.includes("| a | b |\n|---|---|\n| 1 | 2 |"), "a table stays together");
	assert.deepEqual(
		d.live().map((b) => b.kind),
		// (the quote right after a paragraph line continues that paragraph's block)
		["heading", "para", "heading", "item", "item", "item", "item", "para", "para", "para", "para", "para"],
	);
	// \r\n and extra blank lines are normalised; nothing else is.
	assert.equal(Draft.fromMarkdown("\n\nA\r\nB\r\n\r\n\r\n- x\n\n").markdown(), "A\nB\n\n- x");
	// An unclosed fence runs to the end.
	assert.deepEqual(markdownBlocks("Text\n```\ncode\n\n## not a heading"), [
		{ src: "Text", gap: false },
		{ src: "```\ncode\n\n## not a heading", gap: false },
	]);
	// The ordinary constructor splits the same way but normalises spacing.
	assert.equal(new Draft("## Goal\nShip it.\nToday.\n- a\n- b").markdown(), "## Goal\n\nShip it.\nToday.\n\n- a\n- b");
});

test("edited as text: unchanged blocks keep their ids and glow, the rest are typed and protected", () => {
	const d = new Draft("## Requirements\n- Retry uploads\n- Keep the queue");
	const [h, a, b] = d.live();
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Glowing point" }] }, 500);
	const glowing = d.live().at(-1)!;
	const text = "## Requirements\n- Retry uploads, three times\n- Keep the queue\n- Glowing point\n\nA note\nover two lines.\n\n```\ncode\n```";
	d.setMarkdown(text, 1000);
	assert.equal(d.markdown(), text);
	const live = d.live();
	assert.equal(live[0], h);
	assert.equal(live[2], b);
	assert.equal(live[3], glowing);
	assert.equal(glowing.changedAt, 500, "still glowing");
	assert.notEqual(live[1], a);
	assert.equal(live[1]!.typedAt, 1000);
	assert.equal(live[1]!.changedAt, undefined);
	assert.equal(live[4]!.src, "A note\nover two lines.");
	// The model leaves typed text alone when asked to protect it.
	const ids = d.apply({ edits: [{ op: "change", id: `p${live[1]!.id}`, text: "Model rewrite" }] }, 2000, { protect: (x) => x.typedAt !== undefined });
	assert.deepEqual(ids, []);
});

// ── the view ──

const fakeTheme = () =>
	({
		colors: { userMessageBg: rgbColor(40, 40, 40), accent: rgbColor(0, 160, 255) },
		getColorMode: () => "truecolor",
		fg: (_c: string, t: string) => `\x1b[38;5;1m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
		italic: (t: string) => t,
		strikethrough: (t: string) => `\x1b[9m${t}\x1b[29m`,
	}) as any;

function view(draft: Draft, status: Partial<ViewStatus> = {}) {
	const clock = { t: 0 };
	let renders = 0;
	const st: ViewStatus = { state: "ready", elapsedMs: 0, ...status };
	const tui = {
		terminal: { rows: 30, columns: 80 },
		children: [],
		requestRender: () => renders++,
		addInputListener: () => () => {},
	} as any;
	const v = new DraftView(tui, fakeTheme(), draft, {
		status: () => st,
		onEnter() {},
		onEscape() {},
		onAltM() {},
		now: () => clock.t,
		markdownTheme: getMarkdownTheme(),
		animate: false,
	});
	return { v, clock, st, renders: () => renders };
}

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

test("a paste keeps its lines: paragraphs, list items and fences become blocks; control characters go, the rest stays", () => {
	const d = new Draft("## Requirements\n- Retry uploads");
	const { v } = view(d);
	// The cursor is at the end of the last block; the paste continues it and adds blocks after it.
	v.handleInput(paste(" quietly\r\n- Keep the queue\r\n  on disk\r\n\r\nSome context\nover two lines\x07.\n\n```ts\nconst a = 1;\n\n\tif (a) go();\n```"));
	assert.equal(
		d.markdown(),
		"## Requirements\n\n- Retry uploads quietly\n- Keep the queue\n  on disk\n\nSome context\nover two lines.\n\n```ts\nconst a = 1;\n\n\tif (a) go();\n```",
	);
	assert.ok(d.live().every((b) => b.changedAt === undefined), "pasting never glows");
	assert.ok(d.live().slice(1).every((b) => b.typedAt !== undefined), "pasted blocks are the developer's");
	// A paste in the middle of a block: the text after the cursor ends up after the pasted text.
	const e = new Draft("Before after");
	const ev = view(e).v;
	for (let i = 0; i < 5; i++) ev.handleInput("\x1b[D");
	ev.handleInput(paste("middle\n\nnew paragraph "));
	assert.equal(e.markdown(), "Before middle\n\nnew paragraph after");
	ev.handleInput("X");
	assert.equal(e.markdown(), "Before middle\n\nnew paragraph Xafter", "the cursor is where the paste ended");
	// A paste in pieces, and one from a terminal without bracketed paste.
	const f = new Draft("Start");
	const fv = view(f).v;
	fv.handleInput("\x1b[200~\nline one\nline");
	fv.handleInput(" two\x1b[201~");
	assert.equal(f.markdown(), "Start\nline one\nline two");
	fv.handleInput("\r- item a\r- item b");
	assert.equal(f.markdown(), "Start\nline one\nline two\n- item a\n- item b");
	// Typed keys go in as typed: a tab stays a tab; a single control key does nothing.
	const g = new Draft("x");
	const gv = view(g).v;
	gv.handleInput("\t");
	gv.handleInput("\x07");
	assert.equal(g.markdown(), "x\t");
});

test("typing into an empty draft starts a block at the first key; shift+enter splits, or adds a line inside a fence", () => {
	const d = new Draft();
	const { v } = view(d);
	v.handleInput("\x1b[A"); // a key that isn't text does nothing
	assert.equal(d.live().length, 0);
	for (const ch of "Hi") v.handleInput(ch);
	assert.equal(d.markdown(), "Hi");
	assert.ok(d.live()[0]!.typedAt !== undefined);
	v.handleInput("\x1b[D"); // left: "H|i"
	v.handleInput("\x1b[13;2u"); // shift+enter: "i" moves to a new block
	assert.deepEqual(
		d.live().map((b) => b.src),
		["H", "i"],
	);
	v.handleInput("\x7f"); // backspace at the start of a block joins it to the one before
	assert.deepEqual(
		d.live().map((b) => b.src),
		["Hi"],
	);
	v.handleInput("\x1b[F"); // end
	v.handleInput("\x1b[13;2u");
	for (const ch of "```") v.handleInput(ch);
	v.handleInput("\x1b[13;2u");
	for (const ch of "code") v.handleInput(ch);
	v.handleInput("\x1b[13;2u");
	for (const ch of "```") v.handleInput(ch);
	assert.equal(d.markdown(), "Hi\n\n```\ncode\n```");
	// Up and down move within a block of several lines first.
	v.handleInput("\x1b[A");
	v.handleInput("!");
	assert.equal(d.markdown(), "Hi\n\n```\ncod!e\n```");
	// After the closing fence, shift+enter starts a new block.
	v.handleInput("\x1b[B");
	v.handleInput("\x1b[F");
	v.handleInput("\x1b[13;2u");
	for (const ch of "Done") v.handleInput(ch);
	assert.equal(d.markdown(), "Hi\n\n```\ncod!e\n```\n\nDone");
	// The block under the cursor shows its source, one rendered line per source line.
	const shown = v.bodyLines(76).map((l) => stripTerminalSequences(l.text));
	assert.ok(shown.includes("Done "), shown.join("|"));
});

test("the view redraws only while something moves: the clock's second, a fading glow, a strike-through", () => {
	const d = new Draft("## Requirements\n- One");
	const { v, clock, st, renders } = view(d, { state: "ready" });
	v.render(80);
	const before = renders();
	for (let t = 0; t < 5000; t += 250) assert.equal(v.frame((clock.t = t)), false, `idle at ${t}`);
	assert.equal(renders(), before);
	// A dictated change glows: frames run until it has faded, then stop.
	clock.t = 10_000;
	d.apply({ edits: [{ op: "add", section: "Requirements", text: "Two" }] }, clock.t);
	assert.equal(v.frame(10_250), true);
	assert.equal(v.frame(10_000 + 2 * GLOW_STEP_MS), true);
	assert.equal(v.frame(10_000 + 5 * GLOW_STEP_MS), false);
	// A removed point redraws once more when its strike-through ends.
	d.apply({ edits: [{ op: "remove", match: "One" }] }, 20_000);
	assert.equal(v.frame(20_000 + 6 * GLOW_STEP_MS), true, "pruned");
	assert.equal(v.frame(20_000 + 7 * GLOW_STEP_MS), false);
	// Listening: once per second of the clock.
	st.state = "listening";
	st.elapsedMs = 3000;
	v.render(80);
	assert.equal(v.frame(40_000), false, "same second");
	st.elapsedMs = 4000;
	assert.equal(v.frame(40_250), true);
});

// ── long speech ──

test("a long stretch of speech is drafted in pieces cut at sentences, none over the update limit", async () => {
	const asked: string[] = [];
	const complete = async (system: string, user: string) => {
		assert.equal(system, DRAFT_SYSTEM);
		asked.push(user.split("NEW SPEECH:\n")[1]!);
		return JSON.stringify({ edits: [{ op: "add", section: "Requirements", text: `piece ${asked.length}` }] });
	};
	const dr = new Drafter({ complete, draft: new Draft(), now: () => 0 });
	// Ten minutes of talking heard at once (a whole recording from the iPhone app): 1300 words.
	const sentences = Array.from({ length: 130 }, (_, i) => `Sentence number ${i} has exactly ten words in it ok.`);
	dr.heard(sentences.join(" "));
	await dr.settle();
	assert.equal(dr.pending(), "");
	assert.ok(asked.length >= 6, `${asked.length} updates`);
	for (const a of asked) {
		const n = a.split(/\s+/).length;
		assert.ok(n <= MAX_UPDATE_WORDS, `${n} words`);
		assert.match(a, /ok\.$/, "cut at a finished sentence");
	}
	assert.equal(asked.join(" "), sentences.join(" "), "every word sent once, in order");
	// A failure stops the loop; what's left stays pending for the next try.
	let calls = 0;
	const flaky = new Drafter({
		complete: async () => {
			if (++calls > 1) throw new Error("offline");
			return '{"edits": []}';
		},
		draft: new Draft(),
		now: () => 0,
	});
	flaky.heard(sentences.join(" "));
	await flaky.settle();
	assert.equal(calls, 2);
	assert.ok(flaky.pending().startsWith("Sentence number 25 "), flaky.pending().slice(0, 40));
});

test("transcripts started in the same millisecond get different files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-speech-names-"));
	const at = new Date("2026-10-12T10:00:00.123Z");
	const a = new TranscriptFile(dir, at);
	const b = new TranscriptFile(dir, at);
	assert.notEqual(a.path, b.path);
	assert.match(a.path, /2026-10-12T10-00-00-123Z-[0-9a-f]{8}\.txt$/);
});
