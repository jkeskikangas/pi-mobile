// Long dictation: the draft forms while you talk. At each natural pause (or after ~15 s of speech
// without one) the fast model gets the current draft and the speech since the last update and
// returns section edits; one update is in flight at a time. When you finish, one pass with the
// session's model checks the draft against the whole transcript and corrects only what's wrong.
// What was said is written to disk as it is recognised, so neither a crash nor Esc loses it.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { collapseRepeats } from "./distill.ts";
import { type Block, type Draft, type DraftUpdate, namedShape, OPEN_QUESTIONS, parseUpdate, pointText, type SectionEdit, SHAPES } from "./draft.ts";
import type { Complete } from "./model.ts";
import { matchNames, salientFiles, type Vocabulary } from "./vocab.ts";

export const MAX_MS = 10 * 60_000;
export const WARN_MS = MAX_MS - 60_000;
export const SILENCE_STOP_MS = 30_000;
/** A dictation becomes a draft after this much speech (and DRAFT_WORDS words). */
export const DRAFT_AFTER_MS = 30_000;
const DRAFT_WORDS = 40;
/** Earlier, when the first update finds a description rather than a request, after this many words. */
const DESCRIPTION_WORDS = 12;
export const PAUSE_MS = 1500;
export const MAX_SPEECH_MS = 15_000;
const MIN_WORDS = 4;
/**
 * At most this many words of speech per update (about two minutes of talking), cut at a finished
 * sentence: a long stretch heard at once (a whole recording from the iPhone app, a recogniser that
 * delivers a minute at a time, a model that was down for a while) goes in as several updates, so
 * no single answer has to hold the whole draft and nothing is cut off at the output limit.
 */
export const MAX_UPDATE_WORDS = 250;
const KEEP_DAYS = 7;

// ── when ───────────────────────────────────────────────────────────────────────────────────────────────────

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Length is not a mode: a long dictation, or one the first update found to be a description, becomes a draft. */
export function becomesDraft(s: { elapsedMs: number; words: number; kind?: "request" | "description" }): boolean {
	return (s.elapsedMs >= DRAFT_AFTER_MS && s.words >= DRAFT_WORDS) || (s.kind === "description" && s.words >= DESCRIPTION_WORDS);
}

/** Pauses are thinking: only the limit ends a recording, or silence when nothing was said at all. */
export function stopReason(s: { elapsedMs: number; silentMs: number; heard: boolean }): "limit" | "silence" | undefined {
	if (s.elapsedMs >= MAX_MS) return "limit";
	if (!s.heard && s.silentMs >= SILENCE_STOP_MS) return "silence";
	return undefined;
}

// ── prompts ─────────────────────────────────────────────────────────────────────────────────────────────────

const SHAPE_LIST = Object.entries(SHAPES)
	.map(([shape, sections]) => `   - ${shape}: ${sections.join(", ")}`)
	.join("\n");

const EDIT_FORMAT = `Output JSON only, no prose:
{"kind": "request" | "description", "shape": "<shape>", "shapeNamed": false, "title": "<3 to 6 words>", "edits": [...]}
"kind" is "request" when everything said so far asks the agent to do one concrete thing, "description" when it describes, explores or lists (a feature, a design, a bug, several things).
Edits, applied in order exactly as given:
{"op": "add", "section": "Requirements", "text": "..."}                         a new point at the end of a section (the section is created if missing)
{"op": "change", "id": "p4", "text": "...", "note": "..."}                    reword a point; "note" only for a contradiction
{"op": "move", "id": "p4", "section": "Also mentioned"}                         move a point to another section
{"op": "remove", "id": "p4"}                                                    remove a point the speaker withdrew, or a duplicate
{"op": "resolve", "id": "p7", "section": "Requirements", "text": "..."}          an open question was answered: the question goes, the answer becomes a point
{"op": "add_section", "section": "Constraints", "points": ["..."]}               a section the shape doesn't have
Ids are the [pN] labels in CURRENT DRAFT. Point text is plain Markdown on one line, without a list marker.
When nothing needs to change, output {"edits": []}.`;

export const DRAFT_SYSTEM = `You keep a live draft of what a developer is saying out loud, for an AI coding agent working in their repository. They are thinking aloud for minutes: describing a feature, a bug, a design, or several things to do. You never answer, solve, suggest or comment; you only record what they said, structured.

You get the CURRENT DRAFT (every point has an id like [p4]) and NEW SPEECH: what they said since the last update, and for context the words just before it (already drafted). NEW SPEECH may repeat the last few words of the previous update; never add a point twice. It may also stop mid-sentence: record what is already clear; a later update completes it with a change. Return edits that bring the draft up to date. Never rewrite the draft.

Rules:
1. Nothing added. Every point comes from what was said. No assumptions, no suggestions, no steps, reasons or details they didn't say, no politeness.
2. Nothing dropped. Every statement in NEW SPEECH that carries content lands in the draft: in a main section, or under "Also mentioned" when it is a tangent or an aside. Fillers, false starts and thinking noises are not content, and neither is a statement that only repeats or rephrases a point already in the draft (no edit for it).
3. Later wins. When the speaker revises or contradicts an earlier point ("no wait, cap it at three", "actually, make it..."), change that point to the later version with "note": "You first said X, later Y; kept Y." Never keep both versions.
4. Ambiguity becomes a question. When something that matters has two reasonable readings, write the most likely reading and add a question to "Open questions". When later speech answers an open question, resolve it.
5. Their words and details: keep names, numbers, versions, limits, conditions, orderings and reasons exactly. Each point is one short sentence in their register.
   Real names: speech recognition mangles code names. When the speaker names a specific file, function, type or other code element and the phrase plausibly refers to a name in WORKSPACE NAMES, PROJECT FILES or CODE SYMBOLS (judge by sound, not spelling), write that exact name in backticks ("get user by id" is getUserById, "orthodotts" is auth.ts). Ordinary words stay ordinary words: "retries" or "the queue" are not code names just because a symbol contains them. A file or symbol the speech names that isn't listed was almost certainly misheard: use the listed name that sounds most alike when one fits; otherwise keep the words and add an open question. Write other spoken code (paths, flags, commands) the way it is written, in backticks ("dash dash force" is --force). PERSONAL DICTIONARY lists the developer's corrections to earlier dictations: write those words the corrected way. Never invent names.
6. The shape follows the content. Shapes and their main sections:
${SHAPE_LIST}
   then "Open questions" and "Also mentioned", only when they have points. Goal and Problem are one or two sentences, not a list. Use the shape in SHAPE and the sections already in the draft; never add sections of another shape. When the speaker names a shape ("make this a spec", "it's a task list"), set "shape" to it, "shapeNamed": true, and move the points into its sections.
7. Stable. Change only what the new speech changes: don't reword points that are right, don't reorder, don't merge. Don't connect statements the speaker didn't connect, and don't attribute anything to a person, project or place they didn't.
8. Speech about the draft itself ("drop the third point", "move that to open questions", "the second requirement should say...") is an instruction: apply it with edits; it is not a point.
9. Write in the language the speaker used.

${EDIT_FORMAT}`;

export const RECONCILE_SYSTEM = `You check a draft against the full transcript of what a developer said out loud. A faster model wrote the draft live, piece by piece; it may have missed a point, invented one, mangled a detail, or kept the wrong side of a self-correction. You return corrections only.

Rules:
1. A point the speaker made that the draft lacks: add it to the right section (tangents and asides to "Also mentioned").
2. A point the transcript doesn't support: remove it. Nothing in the draft may go beyond what was said. A point that is only thinking aloud ("that covers it", "where was I") or repeats another point: remove it.
3. A point that kept the earlier side of a self-correction: change it to the later version with "note": "You first said X, later Y; kept Y."
4. A detail (name, number, limit, condition) that differs from what was said: change the point. When the speaker names a specific code element that plausibly means a name in WORKSPACE NAMES, PROJECT FILES or CODE SYMBOLS (judge by sound: recognisers mangle identifiers), write that exact name in backticks; ordinary words that only resemble a symbol ("retries", "the queue") stay as said.
5. A point in the wrong section (a tangent among the requirements, a requirement under "Also mentioned"): move it.
6. An open question stays under "Open questions" unless a later statement in the transcript answers it. Then resolve it with the answer as "text" and the section the answer belongs in. Never remove or move an open question any other way: something the speaker said they haven't decided or aren't sure about is an open question, not an aside.
7. Instructions the speaker gave about the draft itself ("drop that point") were already applied: respect them.
8. Otherwise don't reword points that are right, don't restructure, don't reorder. A faithful draft gets {"edits": []}.

${EDIT_FORMAT}`;

/**
 * The workspace's names, given to the model the way distillation gives them: names that may have
 * been meant in this speech (with what was heard), recent names, project files, the personal
 * dictionary and declared symbols. Identifiers are what recognisers get wrong most.
 */
export function vocabularyPrompt(speech: string, v: Vocabulary): string {
	const matches = matchNames(speech, v, 30, 0.5);
	const matched = (n: string) => matches.some((m) => m.name === n);
	const names = [...matches.map((m) => `${m.name}   (maybe heard as "${m.heard}")`), ...v.recent.slice(0, 60).filter((r) => !matched(r))];
	const files = salientFiles(v, 200).filter((f) => !matched(f));
	const symbols = (v.symbols ?? []).slice(0, 250).filter((s) => !matched(s));
	return [
		`PROJECT: ${v.project}${v.branch ? ` (branch ${v.branch})` : ""}`,
		names.length ? `WORKSPACE NAMES:\n${names.join("\n")}` : "",
		files.length ? `PROJECT FILES${v.files.length > files.length ? ` (${files.length} of ${v.files.length})` : ""}:\n${files.join("\n")}` : "",
		v.learned?.length ? `PERSONAL DICTIONARY:\n${v.learned.map((c) => `"${c.from}" -> ${c.to}`).join("\n")}` : "",
		symbols.length ? `CODE SYMBOLS${(v.symbols?.length ?? 0) > symbols.length ? " (most used)" : ""}: ${symbols.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function updatePrompt(draft: Draft, speech: string, opts: { vocabulary?: string; mode?: "live" | "change"; before?: string } = {}): string {
	const shape = draft.shapeNamed
		? `SHAPE: ${draft.shape} (named by the speaker)`
		: draft.empty
			? `SHAPE: ${draft.shape} (a first guess: pick the shape that fits the speech)`
			: `SHAPE: ${draft.shape} (keep it unless the speaker names another)`;
	const parts = [
		shape,
		opts.vocabulary ?? "",
		`CURRENT DRAFT:\n${draft.forModel()}`,
		opts.before?.trim() ? `SAID JUST BEFORE (already in the draft; context only):\n…${opts.before}` : "",
		opts.mode === "change"
			? `NEW SPEECH (the draft is finished; the developer is now changing it by voice: apply what they ask; anything new they say is added as points):\n${speech}`
			: `NEW SPEECH:\n${speech}`,
	];
	return parts.filter(Boolean).join("\n\n");
}

export function reconcilePrompt(draft: Draft, transcript: string, vocabulary = ""): string {
	return [`SHAPE: ${draft.shape}`, vocabulary, `CURRENT DRAFT:\n${draft.forModel()}`, `TRANSCRIPT (everything the developer said, in order):\n${collapseRepeats(transcript)}`]
		.filter(Boolean)
		.join("\n\n");
}

/** One update: asks for section edits for `speech`; the shape the speaker named out loud wins over the model's guess. */
export async function requestUpdate(
	complete: Complete,
	draft: Draft,
	speech: string,
	opts: { vocabulary?: string; mode?: "live" | "change"; before?: string; signal?: AbortSignal } = {},
): Promise<DraftUpdate> {
	const out = await complete(DRAFT_SYSTEM, updatePrompt(draft, collapseRepeats(speech), opts), { signal: opts.signal, maxTokens: 2000 });
	const u = parseUpdate(out);
	const named = namedShape(speech);
	if (named) return { ...u, shape: named, shapeNamed: true };
	return u;
}

/** The finishing pass: compares the draft with the whole transcript and applies only corrections. */
export async function reconcile(
	complete: Complete,
	draft: Draft,
	transcript: string,
	now: () => number,
	opts: { signal?: AbortSignal; vocabulary?: string } = {},
): Promise<number[]> {
	const out = await complete(RECONCILE_SYSTEM, reconcilePrompt(draft, transcript, opts.vocabulary), { signal: opts.signal, maxTokens: 4000 });
	const u = parseUpdate(out);
	if (!u.ok) throw new Error("the check returned something unreadable");
	// What you typed is yours: the check never overwrites it.
	return draft.apply({ edits: keepOpenQuestions(draft, u.edits) }, now(), { protect: (b) => b.typedAt !== undefined });
}

/**
 * Faithfulness for the finishing check: an ambiguity stays an open question unless what was said
 * resolves it, and then the answer goes where it belongs. So the check may not remove an open
 * question, move it out of Open questions, or resolve it without an answer; a duplicate of another
 * open question may go. (Live updates and changes by voice may drop one: the speaker can say so.)
 */
function keepOpenQuestions(draft: Draft, edits: SectionEdit[]): SectionEdit[] {
	const isQuestion = (b: Block | undefined): b is Block => !!b && norm(draft.sectionOf(b)) === norm(OPEN_QUESTIONS);
	const gone = new Set<Block>();
	// A copy that stays (not one already let go in this same check).
	const duplicate = (b: Block) =>
		draft.live().some((o) => o !== b && !gone.has(o) && o.kind !== "heading" && isQuestion(o) && norm(pointText(o.src)) === norm(pointText(b.src)));
	return edits.filter((e) => {
		if (e.op !== "remove" && e.op !== "move" && e.op !== "resolve") return true;
		const b = draft.find(e.id, e.match);
		if (!isQuestion(b)) return true;
		if (e.op === "resolve") return !!e.text?.trim() && norm(e.section ?? "") !== norm(OPEN_QUESTIONS);
		if (e.op === "move") return norm(e.section) === norm(OPEN_QUESTIONS);
		if (!duplicate(b)) return false;
		gone.add(b);
		return true;
	});
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ── continuous drafting ─────────────────────────────────────────────────────────────────────────────────────

/** Words of `full` after the already-sent `sent` (the recogniser may revise the last words it gave). */
export function newSpeech(sent: string, full: string): string {
	return speechSince(sent, full).fresh.join(" ");
}

/** `full` split into the words already sent (as the recogniser has them now) and the fresh ones. */
export function speechSince(sent: string, full: string): { prefix: string[]; fresh: string[] } {
	const a = sent.split(/\s+/).filter(Boolean);
	const b = full.split(/\s+/).filter(Boolean);
	const k = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	let i = 0;
	while (i < a.length && i < b.length && k(a[i]!) === k(b[i]!)) i++;
	return { prefix: b.slice(0, i), fresh: b.slice(i) };
}

/** Without a pause, an update stops at the last finished sentence; the rest goes with the next one. */
export function finishedSentences(words: string[]): string[] {
	const end = (w: string) => /[.?!]["')”]?$/.test(w);
	if (!words.length || end(words[words.length - 1]!)) return words;
	for (let i = words.length - 2; i >= 0; i--) if (/[.?!]["')”]?$/.test(words[i]!)) return words.slice(0, i + 1);
	return words;
}

/** The first `max` words, cut at the last finished sentence in their second half when there is one. */
export function firstPiece(words: string[], max = MAX_UPDATE_WORDS): string[] {
	if (words.length <= max) return words;
	const head = words.slice(0, max);
	const cut = finishedSentences(head);
	return cut.length >= max / 2 ? cut : head;
}

export interface DrafterOptions {
	complete: Complete;
	draft: Draft;
	now?: () => number;
	/** The workspace's names for this speech (WORKSPACE NAMES, PROJECT FILES, CODE SYMBOLS…), see vocabularyPrompt. */
	vocabulary?: (speech: string) => string;
	/** After each applied update, with the changed block ids. */
	onUpdate?: (changed: number[], u: DraftUpdate) => void;
	onError?: (e: unknown) => void;
}

/** What an update sends: settled segments, everything at a pause, finished sentences, or all that's left. */
type Source = "settled" | "pause" | "backstop" | "all";

export class Drafter {
	/** Everything heard so far. */
	heardText = "";
	/** What the recogniser has settled on (segments end at pauses). */
	settledText = "";
	/** What has been sent to the model. */
	sent = "";
	kind?: "request" | "description";
	updates = 0;
	failures = 0;
	lastError?: string;
	inFlight?: Promise<void>;
	private lastHeardAt: number;
	private lastSettledAt = 0;
	private finalsSeen = false;
	private firstNewAt?: number;
	private retryAt = 0;
	private abort = new AbortController();
	private now: () => number;
	private opts: DrafterOptions;

	constructor(opts: DrafterOptions) {
		this.opts = opts;
		this.now = opts.now ?? Date.now;
		this.lastHeardAt = this.now();
	}

	get draft(): Draft {
		return this.opts.draft;
	}

	/** No update has ever worked: drafting is unavailable (no model), so the dictation stays a prompt. */
	get broken(): boolean {
		return this.updates === 0 && this.failures >= 2;
	}

	/** Everything heard so far, settled or not. */
	heard(text: string): void {
		if (text === this.heardText) return;
		this.heardText = text;
		this.lastHeardAt = this.now();
		this.firstNewAt ??= this.lastHeardAt;
	}

	/** Everything the recogniser has settled on so far (it settles a segment at each pause). */
	settled(text: string): void {
		this.settledText = text;
		this.finalsSeen = true;
		this.lastSettledAt = this.now();
	}

	pending(): string {
		return newSpeech(this.sent, this.heardText);
	}

	/** What the next update would send, if one is due now. */
	private next(now: number): Source | undefined {
		if (this.inFlight || now < this.retryAt || !wordCount(this.pending())) return undefined;
		if (this.finalsSeen) {
			// Updates follow the recogniser's settled segments: they land at natural pauses and don't change.
			const settled = wordCount(newSpeech(this.sent, this.settledText));
			if (settled >= MIN_WORDS || (settled && now - this.lastSettledAt >= 4000)) return "settled";
		} else {
			// A recogniser that doesn't settle segments: a pause in the text.
			const quiet = now - this.lastHeardAt;
			if (quiet >= PAUSE_MS && (wordCount(this.pending()) >= MIN_WORDS || quiet >= 4000)) return "pause";
		}
		// Long speech without a pause: what has been said so far, up to the last finished sentence.
		if (this.firstNewAt !== undefined && now - this.firstNewAt >= MAX_SPEECH_MS) return "backstop";
		return undefined;
	}

	/** At a pause (or after a long stretch of speech without one), with no update in flight. */
	due(now = this.now()): boolean {
		return this.next(now) !== undefined;
	}

	tick(now = this.now()): Promise<void> | undefined {
		const source = this.next(now);
		return source ? this.update("live", source) : undefined;
	}

	/** Sends the speech since the last update; resolves when its edits are applied (or it failed). */
	update(mode: "live" | "change" = "live", source: Source = "all"): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const { prefix, fresh } = speechSince(this.sent, source === "settled" ? this.settledText : this.heardText);
		const take = firstPiece(source === "backstop" ? finishedSentences(fresh) : fresh);
		const speech = take.join(" ");
		if (!speech.trim()) return Promise.resolve();
		const full = [...prefix, ...take].join(" ");
		const before = prefix.slice(-40).join(" ");
		const askedAt = this.now();
		const firstNewAt = this.firstNewAt;
		// Words heard but not sent count as new speech from now.
		this.firstNewAt = wordCount(newSpeech(full, this.heardText)) ? askedAt : undefined;
		const run = (async () => {
			try {
				const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]);
				const u = await requestUpdate(this.opts.complete, this.opts.draft, speech, { vocabulary: this.opts.vocabulary?.(speech), mode, before, signal });
				if (this.abort.signal.aborted) return;
				if (!u.ok) throw new Error("the drafting model returned something unreadable");
				this.sent = full;
				this.updates++;
				this.failures = 0;
				this.lastError = undefined;
				this.kind ??= u.kind;
				// Typed after the model was asked: the model's view of that block is stale, so it is left alone.
				const changed = this.opts.draft.apply(u, this.now(), { protect: (b) => (b.typedAt ?? -Infinity) >= askedAt });
				this.opts.onUpdate?.(changed, u);
			} catch (e: any) {
				if (this.abort.signal.aborted) return;
				this.failures++;
				this.lastError = String(e?.message ?? e);
				this.retryAt = this.now() + 3000;
				this.firstNewAt = firstNewAt ?? this.firstNewAt;
				this.opts.onError?.(e);
			} finally {
				this.inFlight = undefined;
			}
		})();
		this.inFlight = run;
		return run;
	}

	/**
	 * Waits for the update in flight, then sends whatever is left (used when the speaker finishes): a
	 * long rest goes in pieces of MAX_UPDATE_WORDS. Stops at a failed update (the rest stays pending).
	 */
	async settle(mode: "live" | "change" = "live"): Promise<void> {
		await this.inFlight;
		for (let i = 0; i < 200 && wordCount(this.pending()) && !this.abort.signal.aborted; i++) {
			const sent = this.sent;
			await this.update(mode, "all");
			if (this.sent === sent) break;
		}
	}

	stop(): void {
		this.abort.abort();
	}
}

// ── the transcript on disk ──────────────────────────────────────────────────────────────────────────────────

export const draftsDir = (speechDir: string) => join(speechDir, "drafts");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * `<speechDir>/drafts/<timestamp>-<random>.txt`: each settled segment is appended as it is recognised.
 * The random part keeps two drafts started in the same millisecond (phone and terminal) apart.
 */
export class TranscriptFile {
	readonly path: string;
	private written = "";

	constructor(dir: string, at = new Date()) {
		this.path = join(dir, `${at.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.txt`);
	}

	append(segment: string): void {
		const s = collapse(segment);
		if (!s) return;
		try {
			mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
			appendFileSync(this.path, `${s}\n`, { mode: 0o600 });
			this.written = this.written ? `${this.written} ${s}` : s;
		} catch {}
	}

	/** At the end: writes whatever of the full transcript isn't on disk yet. */
	complete(full: string): void {
		const f = collapse(full);
		if (!f) return;
		if (!this.written) return this.append(f);
		if (f.startsWith(this.written)) return this.append(f.slice(this.written.length));
		if (!this.written.startsWith(f)) this.append(`(as recognised at the end)\n${f}`);
	}

	get hasText(): boolean {
		return !!this.written;
	}

	text(): string {
		return readTranscript(this.path);
	}

	delete(): void {
		rmSync(this.path, { force: true });
		this.written = "";
	}
}

export function readTranscript(path: string): string {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

/** Deletes transcripts older than a week; returns how many. */
export function pruneTranscripts(dir: string, now = Date.now(), maxAgeMs = KEEP_DAYS * 86_400_000): number {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".txt")) continue;
		const p = join(dir, f);
		try {
			if (now - statSync(p).mtimeMs > maxAgeMs) {
				rmSync(p, { force: true });
				n++;
			}
		} catch {}
	}
	return n;
}

/** The most recent transcript on disk (after a crash, or a draft moved to the editor). */
export function latestTranscript(dir: string): { path: string; text: string } | undefined {
	if (!existsSync(dir)) return undefined;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".txt"))
		.sort()
		.reverse();
	for (const f of files) {
		const text = readTranscript(join(dir, f));
		if (text) return { path: join(dir, f), text };
	}
	return undefined;
}
