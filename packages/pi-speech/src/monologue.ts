// In voice mode: recognising a monologue (designs/voice-modalities.md). A long monologue is thinking
// out loud: the voice must neither interrupt it nor send fragments of it to pi. It becomes a draft,
// the same draft (and full-screen draft view) as a long dictation:
//
//   - the voice model calls the `draft` tool when it recognises composing (describing a feature,
//     listing requirements, reasoning about a design), or continuous speech for more than ~20 s
//     starts one here, locally, so the model can't miss it; nothing already said is lost
//   - a soft tone and the draft view mark it; "no, just answer that" closes it and what was said
//     becomes an ordinary request
//   - while it is open the realtime session creates no responses: pauses never get a reply
//   - "that's it" (or Enter) closes it, and so does "yes" to "is that everything?", asked once
//     after a pause of ~8 s; then the finishing check, one spoken sentence (the output rule), and the
//     open questions one at a time, each answer an edit that glows; "send it" or Enter sends it
//
// Free of pi and devices (tested with a fake clock): the draft itself is behind DraftPort, which
// voice-draft.ts implements with draft-session.ts, drafting.ts and draft-view.ts.

import { norm, stripLead } from "./dialogs.ts";
import { type Draft, OPEN_QUESTIONS, pointText, SHAPES } from "./draft.ts";
import type { Earcon } from "./earcons.ts";
import { countWord } from "./speech.ts";

/** Continuous speech this long, without addressing the voice, starts a draft. */
export const BACKSTOP_MS = 20_000;
/** A pause longer than this ends "continuous" speech. */
export const STREAK_GAP_MS = 2_500;
/** A pause this long while drafting: the voice asks, once, whether that is everything. */
export const CLOSE_PAUSE_MS = 8_000;
/** What was said before a draft starts belongs to it unless the conversation was idle this long. */
export const WINDOW_GAP_MS = 10_000;
export const EVERYTHING = "Is that everything?";
export const NO_MORE_QUESTIONS = "That's all the questions; say send it when you're ready.";

export type DraftCommand = "close" | "undo" | "send" | "keep";

const CLOSE =
	/^(?:(?:yes|yeah|yep|ok|okay|right|alright|so|and|well|i think)\s+)*(?:that's it|that is it|that's all|that is all|that's everything|that is everything|that's the lot|that's about it|that covers it|i'm done|i am done|i'm finished|i am finished|done|finished|finish the draft|end the draft|end of draft|close the draft)(?:\s+(?:for now|then|i think|thanks|thank you))*$/;
const UNDO =
	/^(?:(?:no|nope|wait|hey|sorry)\s+)*(?:(?:just|please)\s+)*(?:answer (?:that|it|this|me|the question)|(?:don't|do not) (?:make|start|write|open) (?:a |this a |it a |that a )?draft|no draft|not a draft|(?:this|that|it) (?:is not|isn't|wasn't|was not) a draft|(?:that's|it's) not a draft|stop drafting)(?:\s+please)?$/;
const SEND =
	/^(?:(?:ok|okay|yes|yeah|great|good|perfect|alright|right|fine)\s+)*(?:send|send it|send that|send the draft|send it to pi|send it off|submit|submit it)(?:\s+(?:please|now|off))*$/;
const KEEP = /^(?:put it in the editor|put the draft in the editor|move it to the editor|keep it as text|i'll type it|i will type it|i'll edit it|let me edit it)$/;
const YES = /^(?:yes|yeah|yep|yup|correct|that's right|right|sure|exactly|i think so|it is)$/;
const NO = /^(?:no|nope|not yet|not quite|wait|hold on|one more thing|almost)$/;
const SKIP = /^(?:skip|skip it|skip that|next|pass|i don't know|don't know|not sure|no idea|leave it|leave it open|leave that open|later)$/;
const ENOUGH = /^(?:no more questions|stop asking|that's enough|enough questions|enough)$/;

const said = (text: string) => stripLead(norm(text));

/** A whole utterance that is a draft command, decided without the model. */
export function parseDraftCommand(text: string): DraftCommand | undefined {
	const t = said(text);
	if (!t || t.split(" ").length > 9) return undefined;
	if (UNDO.test(t)) return "undo";
	if (SEND.test(t)) return "send";
	if (KEEP.test(t)) return "keep";
	if (CLOSE.test(t)) return "close";
	return undefined;
}

/** "…and docs need a section. That's it.": the content, and whether its last sentence closes the draft. */
export function splitClosing(text: string): { content: string; close: boolean } {
	const sentences = text.trim().split(/(?<=[.!?])\s+/);
	if (sentences.length > 1 && CLOSE.test(said(sentences[sentences.length - 1]!))) return { content: sentences.slice(0, -1).join(" "), close: true };
	return { content: text.trim(), close: false };
}

/** The answer to "is that everything?": yes (close), no (keep talking, nothing to add), or content. */
export function everythingAnswer(text: string): "yes" | "no" | "content" {
	const t = said(text);
	if (YES.test(t) || CLOSE.test(t) || (/^(?:yes|yeah|yep)\b/.test(t) && CLOSE.test(t.replace(/^\S+\s+/, "")))) return "yes";
	if (NO.test(t)) return "no";
	return "content";
}

// ── the read-back ──

export interface DraftFacts {
	title: string;
	/** Every point outside Open questions (Also mentioned included), as plain text. */
	points: string[];
	questions: string[];
	/** The sections those points are in, in order. */
	sections: string[];
}

export function draftFacts(d: Draft): DraftFacts {
	const points: string[] = [];
	const prose: string[] = [];
	const questions: string[] = [];
	const sections: string[] = [];
	for (const s of d.sections()) {
		const q = norm(s.name) === norm(OPEN_QUESTIONS);
		for (const p of s.points) {
			const text = pointText(p.src).replace(/\s*\*\(.*\)\*\s*$/, "").trim();
			if (!text) continue;
			if (q) questions.push(text);
			else if (p.kind === "item") points.push(text);
			else prose.push(text);
			if (!q && p.kind === "item" && s.name && !sections.includes(s.name)) sections.push(s.name);
		}
	}
	return { title: d.title, points: points.length ? points : prose, questions, sections };
}

export const READBACK_SYSTEM = `You write the one sentence a voice says after a developer finished describing something out loud; the full draft is on their screen. Format: "Got it: <number> things, <each named in two to four words>, and <number> questions." Name at most four things; with more, name the main areas ("mostly retries, the queue and logging"). Leave out the questions part when there are none. Numbers as words. No code, file names, symbols, markdown or quotes; name things the way a person would. Only what is in the draft; add nothing. Write in the language of the draft. Output the sentence only.`;

export function readBackPrompt(f: DraftFacts): string {
	return [`THINGS (${f.points.length}):`, ...f.points.map((p) => `- ${p}`), `OPEN QUESTIONS: ${f.questions.length}`].join("\n");
}

/** The model's sentence, if usable: one line, no markdown, not a paragraph. */
export function cleanReadBack(out: string): string | undefined {
	const s = String(out ?? "")
		.replace(/[`*_#>"“”]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!s || s.split(" ").length > 45) return undefined;
	return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** An open question as it is asked: drafts sometimes word it as "Whether the cap applies to downloads." */
export function spokenQuestion(q: string): string {
	const t = q.trim();
	if (/\?["')”]*$/.test(t)) return t;
	return `Open question: ${lowerFirst(t).replace(/[.;:,]+$/, "")}.`;
}

/** "Whether" → "whether" mid-sentence; "API" stays. */
const lowerFirst = (s: string) => s.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

/**
 * Without a model: the count, the points themselves when there are a few short ones, otherwise the
 * sections they are in (a point cut to its first words says nothing), and the questions.
 */
export function heuristicReadBack(f: DraftFacts): string {
	const n = f.points.length;
	const q = f.questions.length;
	const questions = q ? `, and ${countWord(q, "question")}` : "";
	if (!n) return q ? `Got it: ${countWord(q, "open question")}; the draft is on screen.` : "Got it; the draft is on screen.";
	const plain = (p: string) => lowerFirst(p.replace(/[`*_]/g, "").replace(/[.,;:!?]+$/, ""));
	if (n <= 3 && f.points.every((p) => p.split(/\s+/).length <= 6)) return `Got it: ${countWord(n, "thing")}, ${and(f.points.map(plain))}${questions}.`;
	const sections = (f.sections ?? []).map((s) => (norm(s) === "also mentioned" ? "a few asides" : s.toLowerCase()));
	return `Got it: ${countWord(n, "thing")}${sections.length ? ` under ${and(sections)}` : ""}${questions}; it's on screen.`;
}

// ── the monologue ──

export type MonologuePhase = "off" | "composing" | "asked" | "finishing" | "clarifying" | "ready" | "changing";

/** One draft on screen, as the monologue needs it (voice-draft.ts; a fake in tests). */
export interface DraftPort {
	/** A turn's words from the realtime transcription: the draft's speech. */
	content(text: string): void;
	/** A turn could not be transcribed: the developer is told to say it again. */
	missed(): void;
	/** Stops listening, sends the last speech, then checks the draft against everything said. */
	finish(): Promise<void>;
	/** Speech that changes the finished draft (an answer to an open question), as edits that glow. */
	change(speech: string): Promise<void>;
	facts(): DraftFacts;
	readBack(f: DraftFacts): Promise<string>;
	/** The open question being asked, shown in the view (undefined: none). */
	asking(question: string | undefined): void;
	/** Sends the draft (to pi, or the other session when switched); the view closes with "sent". */
	send(): void;
	/** The draft goes to pi's editor; the view closes with "kept". */
	keep(): void;
	/** Closes the view without sending ("no, just answer that"). */
	discard(): void;
}

export interface OpenDraft {
	/** Turns already said in this monologue (realtime transcription), in order. */
	seed: string;
	/** Clock time the monologue started (the view's clock starts there). */
	since: number;
	reason: "intent" | "backstop";
	shape?: string;
}

export interface MonologueClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface MonologueHost {
	clock: MonologueClock;
	/** A client event on the realtime data channel. */
	send(ev: Record<string, unknown>): void;
	/** The session's turn detection as configured, restored when the draft closes. */
	turnDetection(): Record<string, unknown>;
	/** Opens the draft view; `events` reports Enter while listening and the view closing. */
	openDraft?(o: OpenDraft, events: { finish(): void; closed(how: "sent" | "kept"): void }): DraftPort;
	/** Stops the voice now (cancels a reply being generated). */
	silence(): void;
	play(e: Earcon): void;
	/** Said exactly, at the next pause. */
	say(line: string): void;
	inject(text: string): void;
	respond(): void;
	quiet(): boolean;
	notify(message: string): void;
	status(): void;
	log?(entry: Record<string, unknown>): void;
}

export class Monologue {
	phase: MonologuePhase = "off";
	port?: DraftPort;
	/** What was said in this monologue (realtime transcription), for "no, just answer that". */
	said: string[] = [];
	question?: string;
	private speaking = false;
	private lastStop = Number.NEGATIVE_INFINITY;
	private lastActivity = Number.NEGATIVE_INFINITY;
	private streak?: { start: number };
	private window?: { start: number; turns: string[] };
	private backstopTimer?: unknown;
	private pauseTimer?: unknown;
	private askedThisPause = false;
	private askedQuestions = new Set<string>();
	private questionsStarted = false;
	private pending: string[] = [];
	private h: MonologueHost;

	constructor(host: MonologueHost) {
		this.h = host;
	}

	/** A draft is open: the voice creates no replies of its own. */
	get active(): boolean {
		return this.phase !== "off";
	}

	/** The developer is still talking it through: pi's news waits too. */
	get composing(): boolean {
		return this.phase === "composing" || this.phase === "asked" || this.phase === "finishing";
	}

	// ── what the developer does ──

	speechStarted(): void {
		const now = this.h.clock.now();
		this.speaking = true;
		this.h.clock.clearTimeout(this.pauseTimer);
		if (this.active) return;
		if (!this.streak || now - this.lastStop > STREAK_GAP_MS) this.streak = { start: now };
		if (!this.window || now - this.lastActivity > WINDOW_GAP_MS) this.window = { start: now, turns: [] };
		this.lastActivity = now;
		this.h.clock.clearTimeout(this.backstopTimer);
		const at = this.streak.start + BACKSTOP_MS - now;
		if (at <= 0) return void this.start("backstop");
		this.backstopTimer = this.h.clock.setTimeout(() => this.backstop(), at);
	}

	speechStopped(): void {
		const now = this.h.clock.now();
		this.speaking = false;
		this.lastStop = this.lastActivity = now;
		if (this.phase === "composing") this.schedulePause();
	}

	/** The voice finished saying something without being interrupted: what follows is a new exchange. */
	voiceDone(): void {
		this.lastActivity = this.h.clock.now();
		if (this.active) return;
		this.streak = undefined;
		this.h.clock.clearTimeout(this.backstopTimer);
	}

	/** A turn's words while no draft is open: they belong to a monologue that may turn into one. */
	track(text: string): void {
		if (!this.active && this.window && text.trim()) this.window.turns.push(text.trim());
	}

	/** A request went to pi, a command was handled, a tool answered: what came before is done with. */
	handoff(): void {
		if (this.active) return;
		this.window = undefined;
		this.streak = undefined;
		this.h.clock.clearTimeout(this.backstopTimer);
	}

	private backstop(): void {
		if (this.active || !this.streak) return;
		const now = this.h.clock.now();
		if (this.speaking || now - this.lastStop <= STREAK_GAP_MS) this.start("backstop");
	}

	/** Opens the draft: by the voice model's `draft` tool (intent) or the duration backstop. */
	start(reason: "intent" | "backstop", shape?: string): boolean {
		if (this.active) return true;
		if (!this.h.openDraft) return false;
		const now = this.h.clock.now();
		const since = Math.min(this.window?.start ?? now, this.streak?.start ?? now);
		this.said = [...(this.window?.turns ?? [])];
		this.window = undefined;
		this.streak = undefined;
		this.h.clock.clearTimeout(this.backstopTimer);
		this.askedQuestions.clear();
		this.questionsStarted = false;
		this.pending = [];
		this.question = undefined;
		this.askedThisPause = false;
		this.phase = "composing";
		this.h.silence();
		// Pauses are thinking: the server is told not to answer them, and nothing here asks it to.
		this.h.send(turnDetectionUpdate({ ...this.h.turnDetection(), create_response: false, interrupt_response: false }));
		this.h.log?.({ draft: "start", reason, since: now - since, seed: this.said.join(" ") });
		let port: DraftPort;
		try {
			port = this.h.openDraft(
				{ seed: this.said.join(" "), since, reason, ...(shape ? { shape } : {}) },
				{
					finish: () => {
						if (this.port === port) void this.finish();
					},
					closed: (how) => {
						if (this.port === port) this.closed(how);
					},
				},
			);
		} catch (e: any) {
			this.h.log?.({ draft: "could not open", error: String(e?.message ?? e) });
			this.end("failed");
			return false;
		}
		this.port = port;
		this.h.play("draft");
		if (!this.speaking) this.schedulePause();
		this.h.status();
		return true;
	}

	/** A turn while the draft is open (the realtime transcription): content, an answer or a command. */
	turn(text: string): void {
		const t = text.trim();
		if (!t || !this.port) return;
		if (this.phase === "finishing" || this.phase === "changing") {
			this.pending.push(t);
			return;
		}
		const cmd = parseDraftCommand(t);
		if (cmd === "undo") return this.undo();
		if (cmd === "keep") return this.port.keep();
		if (this.phase === "composing" || this.phase === "asked") {
			if (cmd === "send") return void this.finish(true);
			if (cmd === "close") return void this.finish();
			if (this.phase === "asked") {
				const a = everythingAnswer(t);
				this.phase = "composing";
				if (a === "yes") return void this.finish();
				if (a === "no") return this.schedulePauseIfQuiet();
			}
			const { content, close } = splitClosing(t);
			this.content(content);
			if (close) void this.finish();
			return;
		}
		if (cmd === "send") return this.port.send();
		if (this.phase === "clarifying") {
			const s = said(t);
			if (SKIP.test(s)) return this.askNext();
			if (ENOUGH.test(s) || cmd === "close") return this.ready(false);
			return void this.change(`Answer to the open question "${this.question}": ${t}`, true);
		}
		// "Yes", "that's it" after the read-back: nothing to change.
		if (cmd === "close" || everythingAnswer(t) !== "content") return;
		void this.change(t, false);
	}

	/** A turn's transcription failed while the draft listens. */
	missed(): void {
		if (this.phase === "composing" || this.phase === "asked") this.port?.missed();
	}

	private content(text: string): void {
		if (!text) return;
		this.said.push(text);
		this.askedThisPause = false;
		this.port?.content(text);
	}

	private schedulePause(): void {
		this.h.clock.clearTimeout(this.pauseTimer);
		this.pauseTimer = this.h.clock.setTimeout(() => this.pause(), CLOSE_PAUSE_MS);
	}

	private schedulePauseIfQuiet(): void {
		if (!this.speaking) this.schedulePause();
	}

	/** A long pause while composing: asked once, quietly. */
	private pause(): void {
		if (this.phase !== "composing" || this.speaking || this.askedThisPause) return;
		this.askedThisPause = true;
		this.phase = "asked";
		this.h.log?.({ draft: "asked" });
		if (this.h.quiet()) this.h.notify(`${EVERYTHING} Say "that's it" or press Enter.`);
		else this.h.say(EVERYTHING);
		this.h.status();
	}

	/** "That's it" (or Enter): the last speech goes in, the finishing check, then the read-back. */
	async finish(thenSend = false): Promise<void> {
		const port = this.port;
		if (!port || (this.phase !== "composing" && this.phase !== "asked")) return;
		this.phase = "finishing";
		this.h.clock.clearTimeout(this.pauseTimer);
		this.h.status();
		this.h.log?.({ draft: "finish", thenSend });
		await port.finish().catch((e) => this.h.log?.({ draft: "finish failed", error: String(e?.message ?? e) }));
		if (this.port !== port) return;
		if (thenSend) return port.send();
		const facts = port.facts();
		const line = await port.readBack(facts).catch(() => heuristicReadBack(facts));
		if (this.port !== port) return;
		this.h.log?.({ draft: "read back", line, questions: facts.questions.length });
		if (this.h.quiet()) this.h.notify(line);
		else this.h.say(line);
		this.phase = "ready";
		if (this.drain()) return;
		this.askNext();
	}

	/** Turns said while the draft was busy: handled in order once it is not. Returns true when one took over. */
	private drain(): boolean {
		while (this.pending.length && this.port && (this.phase === "ready" || this.phase === "clarifying")) {
			this.turn(this.pending.shift()!);
			if (this.phase !== "ready" && this.phase !== "clarifying") return true;
		}
		return !this.port;
	}

	/** The next open question not asked yet; when none is left, the draft waits to be sent. */
	askNext(): void {
		const port = this.port;
		if (!port) return;
		this.questionsStarted = true;
		if (this.h.quiet()) return this.ready(false);
		const q = port.facts().questions.find((x) => !this.askedQuestions.has(norm(x)));
		if (!q) return this.ready(this.phase === "clarifying");
		this.askedQuestions.add(norm(q));
		this.question = q;
		this.phase = "clarifying";
		port.asking(q);
		this.h.say(spokenQuestion(q));
		this.h.status();
	}

	private ready(announce: boolean): void {
		this.question = undefined;
		this.phase = "ready";
		this.port?.asking(undefined);
		if (announce && !this.h.quiet()) this.h.say(NO_MORE_QUESTIONS);
		this.h.status();
	}

	/** An answer to the open question (then the next one), or a change said while the draft waits. */
	private async change(speech: string, answer: boolean): Promise<void> {
		const port = this.port!;
		this.phase = "changing";
		this.h.status();
		this.h.log?.({ draft: answer ? "answer" : "change", speech });
		await port.change(speech).catch((e) => this.h.log?.({ draft: "change failed", error: String(e?.message ?? e) }));
		if (this.port !== port) return;
		this.phase = answer ? "clarifying" : "ready";
		if (this.drain()) return;
		// The questions start after changes said during the finishing check, too.
		if (answer || !this.questionsStarted) this.askNext();
		else this.h.status();
	}

	/** "No, just answer that": the draft closes and what was said is handled as an ordinary request. */
	undo(): void {
		const port = this.port;
		if (!port) return;
		const text = this.said.join(" ").trim();
		this.end("undone");
		port.discard();
		this.h.play("off");
		if (!text) return;
		this.h.inject(
			`[PI] The developer said "no, just answer that": what they said was not a draft. Handle it now as their request, exactly as if they had just said it (pass it to pi with ask_pi, in their words, unless you can answer it from this conversation): "${text}"`,
		);
		this.h.respond();
	}

	/** The draft view closed: sent (Enter, "send it") or put in the editor (Esc). */
	closed(how: "sent" | "kept"): void {
		if (!this.port) return;
		this.end(how);
		this.h.inject(`[PI] The developer's draft was ${how === "sent" ? "sent to pi" : "put in their editor as text; nothing was sent"}. Say nothing about it.`);
	}

	private end(how: string): void {
		this.h.log?.({ draft: "end", how });
		this.phase = "off";
		this.port = undefined;
		this.question = undefined;
		this.pending = [];
		this.said = [];
		this.h.clock.clearTimeout(this.pauseTimer);
		this.h.send(turnDetectionUpdate(this.h.turnDetection()));
		this.h.status();
	}

	close(): void {
		this.h.clock.clearTimeout(this.pauseTimer);
		this.h.clock.clearTimeout(this.backstopTimer);
	}
}

/** session.update for the realtime session's turn detection. */
export function turnDetectionUpdate(turnDetection: Record<string, unknown>): Record<string, unknown> {
	return { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: turnDetection } } } };
}

/** The shapes the `draft` tool accepts. */
export const DRAFT_SHAPES = Object.keys(SHAPES);
