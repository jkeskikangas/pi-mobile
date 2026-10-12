// Long dictation from the phone: the phone records as usual and sends the audio in chunks (cut at
// pauses, every 10-15 s). Each chunk is recognised here with the same STT as everything else, the
// transcript is kept on this computer (the terminal's drafts folder and retention), and the same
// drafting engine as the terminal (drafting.ts, draft.ts) keeps the draft up to date. The phone gets
// the draft's blocks with the ones that changed since it last looked, so exactly those glow.

import { randomBytes } from "node:crypto";
import { Draft, type Block } from "./draft.ts";
import {
	becomesDraft,
	DRAFT_AFTER_MS,
	Drafter,
	MAX_MS,
	newSpeech,
	pruneTranscripts,
	reconcile,
	requestUpdate,
	TranscriptFile,
	vocabularyPrompt,
	WARN_MS,
	wordCount,
} from "./drafting.ts";
import type { Complete } from "./model.ts";
import type { SttProvider } from "./stt.ts";
import { recognizerHints, type Vocabulary } from "./vocab.ts";

/** One chunk (10-15 s of 16 kHz WAV is about 0.5 MB) or one change by voice; generous, but bounded. */
export const MAX_CHUNK = 4 * 1024 * 1024;
/**
 * The last piece, a change by voice, or a whole recording from a recorder that can't send chunks (the
 * iPhone app records natively): the same limit as `transcribe`.
 */
export const MAX_RECORDING = 20 * 1024 * 1024;
/** Removed points stay (struck through on the phone) this long. */
const REMOVED_MS = 6000;
/** A draft the phone stopped talking to is dropped from memory (its transcript stays on disk). */
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 4;
/** How long a `draftState` with `wait` holds the request open for the next change. */
export const WAIT_MS = 20_000;
/** A recording may run a little past the limit (the last chunk is in flight when it ends). */
const LIMIT_SLACK_MS = 30_000;

export interface PhoneDraftsDeps {
	stt: () => SttProvider;
	vocabulary: () => Promise<Vocabulary>;
	/** The fast model: live updates and changes by voice. */
	fast: Complete;
	/** The session's model: the finishing check (falls back to the fast one). */
	careful: Complete;
	/** Where transcripts go: `<speechDir>/drafts`, shared with the terminal. */
	dir: () => string;
	now?: () => number;
}

export type DraftPhase = "listening" | "checking" | "ready";

export interface PhoneBlock {
	id: number;
	kind: Block["kind"];
	/** Markdown source of the block. */
	src: string;
	/** Changed by dictation since the version the phone last saw: it glows. */
	changed?: true;
	/** Removed by dictation since then: shown struck through for a moment. */
	removed?: true;
}

export interface PhoneDraftView {
	id: string;
	version: number;
	phase: DraftPhase;
	/** Long enough (or a description): the phone shows the draft. */
	isDraft: boolean;
	title: string;
	shape: string;
	blocks: PhoneBlock[];
	markdown: string;
	/** Words heard but not in the draft yet (the Hearing line). */
	hearing: string;
	words: number;
	updating: boolean;
	note: string;
	maxMs: number;
	warnMs: number;
	/** From this long on, enough words make it a draft (the phone asks again then, between chunks). */
	draftAfterMs: number;
}

interface Session {
	id: string;
	draft: Draft;
	drafter: Drafter;
	transcript: TranscriptFile;
	vocab?: Vocabulary;
	hints: string[];
	/** Everything recognised so far, chunk after chunk. */
	heard: string;
	nextSeq: number;
	version: number;
	/** Block id → the version in which dictation last changed it. */
	changed: Map<number, number>;
	phase: DraftPhase;
	isDraft: boolean;
	note: string;
	elapsedMs: number;
	touched: number;
	queue: Promise<unknown>;
	waiters: Set<() => void>;
	timer?: ReturnType<typeof setTimeout>;
	/** Aborts the session's model calls (the check, a change by voice) when it is dropped. */
	abort: AbortController;
	/** Markdown the developer typed, verbatim: the draft as sent, until the next change by voice. */
	typed?: string;
	closed: boolean;
}

function audioOf(p: { audio?: unknown }, required: boolean, max: number): Buffer | undefined {
	if (p.audio === undefined || p.audio === null || p.audio === "") {
		if (required) throw new Error("no audio");
		return undefined;
	}
	if (typeof p.audio !== "string") throw new Error("no audio");
	const what = max === MAX_CHUNK ? "recording chunk too large" : "recording too long";
	// Checked before decoding: base64 is 4/3 of the bytes.
	if (p.audio.length > Math.ceil((max * 4) / 3) + 4) throw new Error(what);
	const audio = Buffer.from(p.audio, "base64");
	if (audio.length > max) throw new Error(what);
	return audio;
}

/**
 * A model call that ends when its signal does: rejected at once when the signal is already aborted, and
 * the moment it aborts even if the model ignores the signal, so dropping a draft never waits on a call.
 */
function abortable(complete: Complete): Complete {
	return (system, user, opts) => {
		const signal = opts?.signal;
		if (!signal) return complete(system, user, opts);
		if (signal.aborted) return Promise.reject(new Error("aborted"));
		return new Promise<string>((resolve, reject) => {
			const stop = () => reject(new Error("aborted"));
			signal.addEventListener("abort", stop, { once: true });
			Promise.resolve()
				.then(() => complete(system, user, opts))
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", stop));
		});
	};
}

export class PhoneDrafts {
	private sessions = new Map<string, Session>();
	private disposed = false;
	private deps: PhoneDraftsDeps;
	private now: () => number;

	constructor(deps: PhoneDraftsDeps) {
		this.deps = { ...deps, fast: abortable(deps.fast), careful: abortable(deps.careful) };
		this.now = deps.now ?? Date.now;
	}

	/** A new recording that may become a draft. Old transcripts (over 7 days) are pruned here, as in the terminal. */
	async start(_p: unknown = {}): Promise<PhoneDraftView> {
		// ("not available": the phone takes it as no drafts here, and dictates as before.)
		if (this.disposed) throw new Error("drafts are not available: pi is shutting down");
		const now = this.now();
		for (const s of this.sessions.values()) if (now - s.touched > IDLE_MS) this.drop(s, false);
		while (this.sessions.size >= MAX_SESSIONS) this.drop([...this.sessions.values()].sort((a, b) => a.touched - b.touched)[0]!, false);
		try {
			pruneTranscripts(this.deps.dir(), now);
		} catch {}
		let vocab: Vocabulary | undefined;
		try {
			vocab = await this.deps.vocabulary();
		} catch {}
		if (this.disposed) throw new Error("drafts are not available: pi is shutting down");
		const draft = new Draft();
		const id = randomBytes(9).toString("base64url");
		const s: Session = {
			id,
			draft,
			vocab,
			hints: vocab ? recognizerHints(vocab) : [],
			transcript: new TranscriptFile(this.deps.dir(), new Date(now)),
			drafter: undefined as unknown as Drafter,
			heard: "",
			nextSeq: 0,
			version: 0,
			changed: new Map(),
			phase: "listening",
			isDraft: false,
			note: "",
			elapsedMs: 0,
			touched: now,
			queue: Promise.resolve(),
			waiters: new Set(),
			abort: new AbortController(),
			closed: false,
		};
		s.drafter = new Drafter({
			complete: this.deps.fast,
			draft,
			now: this.now,
			vocabulary: (speech) => this.vocabularyFor(s, speech),
			onUpdate: (ids) => {
				this.decide(s);
				this.bump(s, ids);
			},
		});
		this.sessions.set(id, s);
		return this.view(s, 0);
	}

	/**
	 * The next piece of the recording: recognised, appended to the transcript on disk, and handed to
	 * the drafter (an update starts at once unless one is in flight). Answers as soon as the words are
	 * known; the draft's change arrives through `state` with `wait`.
	 */
	async chunk(p: { id?: unknown; seq?: unknown; audio?: unknown; mime?: unknown; elapsedMs?: unknown; since?: unknown }): Promise<PhoneDraftView> {
		const s = this.get(p.id);
		const audio = audioOf(p, true, MAX_CHUNK)!;
		this.elapsed(s, p.elapsedMs);
		if (s.phase !== "listening") throw new Error("the draft is finished; dictate a change instead");
		return this.serial(s, async () => {
			await this.hear(s, Number(p.seq), audio, String(p.mime ?? "audio/wav"));
			this.decide(s);
			this.pump(s);
			return this.view(s, Number(p.since) || 0);
		});
	}

	/** The draft now; with `wait`, held open until something changes after `since` (at most WAIT_MS). */
	async state(p: { id?: unknown; since?: unknown; wait?: unknown; elapsedMs?: unknown }): Promise<PhoneDraftView> {
		const s = this.get(p.id);
		const since = Number(p.since) || 0;
		// The phone says how long it has been recording (between chunks): long enough may make it a draft now.
		if (p.elapsedMs !== undefined && s.phase === "listening") {
			this.elapsed(s, p.elapsedMs);
			this.decide(s);
		}
		if (p.wait && s.version <= since && !s.closed) {
			await new Promise<void>((resolve) => {
				const done = () => {
					s.waiters.delete(done);
					clearTimeout(t);
					resolve();
				};
				const t = setTimeout(done, WAIT_MS);
				t.unref?.();
				s.waiters.add(done);
			});
		}
		return this.view(s, since);
	}

	/**
	 * The speaker finished (optionally with the last piece of audio). A recording that isn't a draft
	 * (short, and a request) comes back with `isDraft: false` and the words, for ordinary distillation;
	 * a draft gets its last update, then one check against the whole transcript (`check: false` skips
	 * it, for "keep it as text" while recording).
	 */
	async finish(p: {
		id?: unknown;
		seq?: unknown;
		audio?: unknown;
		mime?: unknown;
		elapsedMs?: unknown;
		since?: unknown;
		check?: unknown;
		draft?: unknown;
	}): Promise<PhoneDraftView & { raw: string; checked?: number }> {
		const s = this.get(p.id);
		const audio = audioOf(p, false, MAX_RECORDING);
		this.elapsed(s, p.elapsedMs);
		const since = Number(p.since) || 0;
		return this.serial(s, async () => {
			if (audio && s.phase === "listening") await this.hear(s, Number(p.seq), audio, String(p.mime ?? "audio/wav"));
			if (s.phase !== "listening") return { ...this.view(s, since), raw: s.heard };
			// An update in flight may be the one that finds a description.
			if (!s.isDraft) await s.drafter.inFlight;
			this.decide(s);
			if (p.draft === true && !s.drafter.broken) s.isDraft = true;
			if (!s.isDraft) {
				// A prompt after all: the phone distils the words; the transcript was only the safety net.
				const raw = s.heard;
				this.drop(s, true);
				return { ...this.view(s, since), raw };
			}
			this.setPhase(s, "checking");
			await s.drafter.settle();
			let checked: number | undefined;
			// Dropped meanwhile (pi is shutting down): no check is started on a draft nobody can send.
			if (p.check !== false && !s.closed) {
				const transcript = s.transcript.text() || s.heard;
				try {
					const vocabulary = this.vocabularyFor(s, transcript);
					const ids = await reconcile(this.deps.careful, s.draft, transcript, this.now, { signal: this.signal(s, 90_000), vocabulary }).catch((e) => {
						if (s.closed) throw e;
						return reconcile(this.deps.fast, s.draft, transcript, this.now, { signal: this.signal(s, 60_000), vocabulary });
					});
					// Corrections are points: a section heading that came with one isn't counted.
					checked = ids.filter((id) => s.draft.blocks.find((b) => b.id === id)?.kind !== "heading").length;
					this.bump(s, ids);
					s.note = checked
						? `Checked against everything you said: ${checked} correction${checked > 1 ? "s" : ""}.`
						: "Checked against everything you said: nothing missing.";
				} catch (e: any) {
					s.note = `Couldn't check the draft against what you said (${String(e?.message ?? e).slice(0, 80)}).`;
				}
			}
			if (s.draft.empty && wordCount(s.heard)) s.note = "No model could write the draft. Keep it as text to get what you said.";
			this.setPhase(s, "ready", s.note);
			return { ...this.view(s, since), raw: s.heard, checked };
		});
	}

	/**
	 * Refining a finished draft. `markdown`: the developer edited it as text (those blocks are theirs:
	 * no glow, and the model leaves them alone). `audio`: a change said out loud ("drop the third
	 * point"), applied as section edits that glow.
	 */
	async edit(p: { id?: unknown; markdown?: unknown; audio?: unknown; mime?: unknown; since?: unknown }): Promise<PhoneDraftView & { heard?: string }> {
		const s = this.get(p.id);
		const audio = audioOf(p, false, MAX_RECORDING);
		const since = Number(p.since) || 0;
		if (typeof p.markdown !== "string" && !audio) throw new Error("nothing to change");
		if (typeof p.markdown === "string" && p.markdown.length > 200_000) throw new Error("draft too long");
		return this.serial(s, async () => {
			if (s.phase === "listening") throw new Error("the draft is still forming");
			if (typeof p.markdown === "string") {
				// Unchanged blocks keep their ids (and glow); the rest are the developer's, which the model
				// leaves alone. The text itself is kept verbatim: what the phone sends, until a change by voice.
				s.draft.setMarkdown(p.markdown, this.now());
				s.typed = p.markdown.replace(/\r\n?/g, "\n");
				for (const id of [...s.changed.keys()]) if (!s.draft.blocks.some((b) => b.id === id)) s.changed.delete(id);
				this.bump(s, []);
			}
			if (!audio) return this.view(s, since);
			const t = await this.deps.stt().transcribe(audio, String(p.mime ?? "audio/wav"), s.hints);
			const speech = t.text.trim();
			if (!speech) {
				this.setPhase(s, "ready", "Didn't catch a change. Try again a little closer to the mic.");
				return { ...this.view(s, since), heard: "" };
			}
			s.transcript.append("(changing the draft by voice)");
			s.transcript.append(speech);
			this.setPhase(s, "checking");
			try {
				const u = await requestUpdate(this.deps.fast, s.draft, speech, { mode: "change", vocabulary: this.vocabularyFor(s, speech), signal: this.signal(s, 60_000) });
				if (!u.ok) throw new Error("the model returned something unreadable");
				// Requests to a draft run one at a time, so nothing is typed while the model works: text typed
				// before (also with this request: what you typed goes first) is what the change applies to.
				const ids = s.draft.apply(u, this.now());
				// Changed by voice: the draft is the drafting engine's again (typed blocks are kept as they were).
				if (ids.length) s.typed = undefined;
				this.bump(s, ids);
				this.setPhase(s, "ready", ids.length ? "" : `Nothing changed for “${speech.slice(0, 60)}”.`);
			} catch (e: any) {
				this.setPhase(s, "ready", `Couldn't apply the change (${String(e?.message ?? e).slice(0, 80)}).`);
			}
			return { ...this.view(s, since), heard: speech };
		});
	}

	/** Sent (or discarded): the transcript is deleted. Kept as text: it stays on disk for 7 days. */
	close(p: { id?: unknown; how?: unknown }): { ok: true; transcriptKept: boolean } {
		const s = this.sessions.get(String(p.id ?? ""));
		if (!s) return { ok: true, transcriptKept: false };
		const kept = p.how === "kept" && s.transcript.hasText;
		this.drop(s, !kept);
		return { ok: true, transcriptKept: kept };
	}

	/** For tests and shutdown. */
	get size(): number {
		return this.sessions.size;
	}

	/**
	 * pi is shutting down: every draft is dropped (transcripts stay on disk), its model calls and timers
	 * are cancelled and waiting requests answered; later requests find no draft. Safe to call twice.
	 */
	dispose(): void {
		this.disposed = true;
		for (const s of [...this.sessions.values()]) this.drop(s, false);
	}

	// ── internals ──────────────────────────────────────────────────────────────────────────────────────────────

	private get(id: unknown): Session {
		const s = this.sessions.get(String(id ?? ""));
		if (!s) throw new Error("that draft is no longer open on the computer");
		s.touched = this.now();
		return s;
	}

	private elapsed(s: Session, ms: unknown): void {
		const n = Number(ms);
		if (Number.isFinite(n) && n > s.elapsedMs) s.elapsedMs = n;
		if (s.elapsedMs > MAX_MS + LIMIT_SLACK_MS) throw new Error("the recording passed the 10-minute limit");
	}

	/** One chunk at a time, in order, per draft. */
	private serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
		const run = s.queue.then(fn, fn);
		s.queue = run.catch(() => {});
		return run;
	}

	/** A model call that ends with the session (or after `ms`). */
	private signal(s: Session, ms: number): AbortSignal {
		return AbortSignal.any([s.abort.signal, AbortSignal.timeout(ms)]);
	}

	/**
	 * Recognises each piece once, in order. The phone numbers a piece when it cuts it and retries it on
	 * its own, so a number already heard is the same audio again (a retry after a lost reply): skipped.
	 * A number past the next one means a piece is missing: refused, so the phone sends that one first.
	 * A piece whose recognition failed isn't counted: its retry is heard.
	 */
	private async hear(s: Session, seq: number, audio: Buffer, mime: string): Promise<void> {
		if (!Number.isInteger(seq) || seq < 0) throw new Error("bad chunk number");
		if (seq < s.nextSeq) return;
		if (seq > s.nextSeq) throw new Error("a piece of the recording is missing");
		const t = await this.deps.stt().transcribe(audio, mime, s.hints);
		s.nextSeq = seq + 1;
		const text = t.text.replace(/\s+/g, " ").trim();
		if (!text || s.closed) return;
		// Each chunk ends at a pause, so it is settled as the recogniser's segments are in the terminal.
		s.transcript.append(text);
		s.heard = s.heard ? `${s.heard} ${text}` : text;
		s.drafter.heard(s.heard);
		s.drafter.settled(s.heard);
		this.bump(s, []);
	}

	/** Long enough, or a description: the phone shows the draft. Never undone. */
	private decide(s: Session): void {
		if (s.isDraft || s.drafter.broken) return;
		if (becomesDraft({ elapsedMs: s.elapsedMs, words: wordCount(s.heard), kind: s.drafter.kind })) {
			s.isDraft = true;
			this.bump(s, []);
		}
	}

	/** Starts the next update when one is due; keeps checking while words wait (a short chunk, a failed update). */
	private pump(s: Session): void {
		if (s.closed || s.phase !== "listening") return;
		clearTimeout(s.timer);
		const p = s.drafter.tick();
		if (p) {
			void p.then(() => {
				this.bump(s, []);
				this.pump(s);
			});
			return;
		}
		if (!s.drafter.inFlight && wordCount(s.drafter.pending())) {
			s.timer = setTimeout(() => this.pump(s), 1000);
			s.timer.unref?.();
		}
	}

	private vocabularyFor(s: Session, speech: string): string {
		return s.vocab ? vocabularyPrompt(speech, s.vocab) : "";
	}


	private setPhase(s: Session, phase: DraftPhase, note = ""): void {
		s.phase = phase;
		s.note = note;
		this.bump(s, []);
	}

	/** A new version: blocks in `ids` were changed by dictation (they glow); waiters wake. */
	private bump(s: Session, ids: number[] = []): void {
		s.version++;
		for (const id of ids) s.changed.set(id, s.version);
		for (const w of [...s.waiters]) w();
	}

	private drop(s: Session, deleteTranscript: boolean): void {
		s.closed = true;
		clearTimeout(s.timer);
		s.drafter.stop();
		s.abort.abort();
		if (deleteTranscript) s.transcript.delete();
		this.sessions.delete(s.id);
		for (const w of [...s.waiters]) w();
	}

	private view(s: Session, since: number): PhoneDraftView {
		const now = this.now();
		s.draft.prune(now, REMOVED_MS);
		const blocks: PhoneBlock[] = [];
		for (const b of s.draft.blocks) {
			const fresh = (s.changed.get(b.id) ?? 0) > since;
			if (b.removedAt !== undefined) {
				if (fresh) blocks.push({ id: b.id, kind: b.kind, src: b.src, removed: true });
				continue;
			}
			blocks.push(fresh ? { id: b.id, kind: b.kind, src: b.src, changed: true } : { id: b.id, kind: b.kind, src: b.src });
		}
		const pending = s.phase === "listening" ? newSpeech(s.drafter.sent, s.heard) : "";
		const words = pending.split(" ").filter(Boolean);
		return {
			id: s.id,
			version: s.version,
			phase: s.phase,
			isDraft: s.isDraft,
			title: s.draft.title,
			shape: s.draft.shape,
			blocks,
			markdown: s.typed ?? s.draft.markdown(),
			hearing: words.length > 24 ? `…${words.slice(-24).join(" ")}` : words.join(" "),
			words: wordCount(s.heard),
			updating: !!s.drafter.inFlight,
			note: s.note,
			maxMs: MAX_MS,
			draftAfterMs: DRAFT_AFTER_MS,
			warnMs: WARN_MS,
		};
	}
}
