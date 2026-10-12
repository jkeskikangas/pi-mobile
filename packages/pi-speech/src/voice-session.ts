// Terminal voice mode's conversation logic, free of pi, audio devices and the network so it can be
// tested with a fake clock: the realtime event state machine (a response being generated versus the
// model being heard, barge-in, turns), the output rule and its two switches, the typing gate,
// parking, pi's questions, and the tools the voice model calls. voice-mode.ts wires it to pi, rtc.ts
// and audio-io.ts. Design: designs/voice-modalities.md.

import { answerFor, norm, promptContext, speakPrompt, stripLead, type VoicePrompt } from "./dialogs.ts";
import type { Earcon } from "./earcons.ts";
import { Monologue, type MonologueHost, type MonologuePhase } from "./monologue.ts";
import { isParkedText, parkedMessage, parkLine, pointsAhead, unmark } from "./park.ts";
import { sayInstructions } from "./realtime.ts";
import { TypingGate } from "./typing-gate.ts";

/** The two explicit switches, plus normal. Persisted in the voice config (`voiceSwitch`). */
export type VoiceSwitch = "normal" | "quiet" | "eyes-free";

/** What pi tells the developer: how a request went, a question, a failed significant action. */
export type AnnounceKind = "done" | "question" | "failed";

export interface Route {
	/** Played the moment it happens, even while typing. */
	soundNow?: Earcon;
	/** Played at the next pause, with the speech. */
	soundAtPause?: Earcon;
	/** The sentence is spoken (at the next pause). */
	speak: boolean;
}

/**
 * The output rule: the voice says how it went and when you're needed; the switches change only
 * whether words are spoken, never which sounds mark what. Questions and failures sound at once.
 */
export function route(kind: AnnounceKind, sw: VoiceSwitch): Route {
	const speak = sw !== "quiet";
	if (kind === "question") return { soundNow: "attention", speak };
	if (kind === "failed") return { soundNow: "failed", speak };
	return { soundAtPause: "done", speak };
}

export type TerminalCommand = "send" | "stopTalking" | "stopPi" | "quiet" | "eyesFree" | "normal";

const COMMANDS: [TerminalCommand, RegExp][] = [
	["send", /^(?:send|send it|send that|send the message|submit|submit it)$/],
	["stopPi", /^(?:stop pi|stop the work|stop working|cancel that|cancel it|cancel the request|abort|abort that|abort it|stop everything)$/],
	["quiet", /^(?:go quiet|quiet mode|silent mode|go silent|i'm in a meeting|mute yourself|mute the voice)$/],
	["eyesFree", /^(?:i can't look|i cannot look|eyes free|eyes-free|i'm not looking|i can't see the screen)$/],
	["normal", /^(?:normal|normal mode|back to normal|i can look|i can look again|you can talk again|unmute|unmute yourself)$/],
	["stopTalking", /^(?:stop|stop talking|stop it|shush|hush|enough|be quiet|quiet|shut up|okay stop|ok stop)$/],
];

/** A whole utterance that is a local command, decided without the model. */
export function parseTerminalCommand(text: string): TerminalCommand | undefined {
	const t = stripLead(norm(text));
	if (!t || t.split(" ").length > 7) return undefined;
	return COMMANDS.find(([, re]) => re.test(t))?.[0];
}

/** A listener's "mm-hmm" or a cough, not a turn. */
export function isBackchannel(text: string): boolean {
	const t = norm(text);
	if (!t) return true;
	return /^(?:m+h?m+|mm+ ?hmm+|uh ?huh|uh+|um+|hmm+|ah+|oh+|yeah|yep|yup|ok|okay|right|sure|cool|nice|great|got it|i see|alright|true|exactly|thanks|thank you)$/.test(t);
}

export type VoiceState = "connecting" | "listening" | "speaking" | "working";

export interface VoiceStatus {
	state: VoiceState;
	sw: VoiceSwitch;
	parked: boolean;
	/** The other session the voice talks to ("api @devbox"); absent for this one. */
	target?: string;
	/** A monologue became a draft: where it is (monologue.ts). */
	draft?: Exclude<MonologuePhase, "off">;
}

const DRAFT_STATUS: Record<Exclude<MonologuePhase, "off">, string> = {
	composing: "drafting · \"that's it\" finishes",
	asked: "drafting · \"that's it\" finishes",
	finishing: "draft: checking",
	clarifying: "draft: asking",
	changing: "draft: changing",
	ready: "draft ready",
};

/** The status line: the state at all times, the target when it is another session, the switch when one is on. */
export function statusText(s: VoiceStatus): string {
	const sw = s.sw === "normal" ? "" : ` · ${s.sw}`;
	const parked = s.parked ? ` · parked: finish typing, Enter sends${s.target ? ` to ${s.target}` : ""}` : "";
	const state = s.state === "connecting" ? "connecting…" : s.draft && s.state !== "speaking" ? DRAFT_STATUS[s.draft] : s.state;
	const send = s.draft === "ready" || s.draft === "clarifying" ? ` · "send it" or Enter sends${s.target ? ` to ${s.target}` : ""}` : "";
	return `voice${s.target ? ` → ${s.target}` : ""}: ${state}${sw}${parked}${send}`;
}

/**
 * Other sessions (herdr-targets.ts): which one the voice talks to, and the requests, status and
 * stopping that go there instead of this pi while it is switched.
 */
export interface TargetsPort {
	/** The other session being talked to ("api @devbox"), or undefined for this one. */
	label(): string | undefined;
	ask(text: string): Promise<Record<string, unknown>>;
	list(machine?: string): Promise<Record<string, unknown>>;
	switchTo(name: string): Promise<Record<string, unknown>>;
	status(): Promise<string>;
	stop(): Promise<Record<string, unknown>>;
	/** Its latest answer, for "tell me more". */
	last?: { label: string; text: string };
}

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => {
		const t = setTimeout(fn, ms);
		t.unref?.();
		return t;
	},
	clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** What the voice needs from pi. */
export interface PiPort {
	isIdle(): boolean;
	/** A user message: a new prompt when idle, else steering (or a follow-up). */
	send(text: string, deliverAs?: "steer" | "followUp"): void;
	abort(): void;
	getEditorText(): string;
	setEditorText(text: string): void;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** "What's it doing?" in one sentence. */
	status(): string;
	details(topic: string): Promise<string>;
	/** The "Finish typing · Enter sends" hint while a request is parked. */
	parkHint(on: boolean): void;
}

export interface VoicePorts {
	/** A client event on the realtime data channel. */
	send(ev: Record<string, unknown>): void;
	/** 48 kHz mono s16le out; `flush` drops whatever is still buffered at once. */
	player: { write(pcm: Buffer): void; flush(): void };
	earcon(name: Earcon): Buffer;
	pi: PiPort;
	clock?: Clock;
	/** Instructions for the switch (session.update when it changes). */
	instructions?(sw: VoiceSwitch): string;
	onSwitch?(sw: VoiceSwitch): void;
	onStatus?(s: VoiceStatus): void;
	log?(entry: Record<string, unknown>): void;
	/** Other sessions through herdr; without it the voice talks only to this pi. */
	targets?: TargetsPort;
	/** The realtime session's turn detection as configured (restored after a draft). */
	turnDetection?: Record<string, unknown>;
	/** Opens a draft on screen (voice-draft.ts); without it the voice can't start one. */
	openDraft?: MonologueHost["openDraft"];
	/** The instructions for a response that says one line exactly (the persona's delivery included). */
	sayInstructions?(line: string): string;
}

interface Pending {
	kind: AnnounceKind | "say";
	sentence: string;
	context?: string;
	promptId?: string;
	/** The draft's own line (read-back, a question): spoken even while pi's news waits for the draft. */
	own?: boolean;
}

const DEFAULT_TURN_DETECTION = { type: "server_vad", silence_duration_ms: 700, create_response: false, interrupt_response: false };

export const TRANSCRIPT_WAIT_MS = 1200;
export const TICK_MS = 6000;
const RATE = 48000;

export class VoiceSession {
	sw: VoiceSwitch;
	readonly gate: TypingGate;
	/** response.created → response.done: the model is generating (cancellable). */
	responseActive = false;
	/** output_audio_buffer.started → stopped/cleared: the model is being heard. */
	modelSpeaking = false;
	userSpeaking = false;
	piBusy = false;
	connected = false;
	parked?: { words: string };
	lastSpoken = "";
	/** A monologue that may become, or has become, a draft. */
	readonly mono: Monologue;
	private requested = false;
	/** The line the next response must say exactly (sent with it as its instructions). */
	private pendingSay?: string;
	private wantResponse = false;
	private cancelOnCreate = false;
	private dropAudio = false;
	/** The reply's audio while the developer's words are still being judged (see committed). */
	private held?: Buffer[];
	private playingUntil = 0;
	private turn?: { item?: string; responded: boolean; timer?: unknown };
	private queue: Pending[] = [];
	private pauseSounds: Earcon[] = [];
	private flushTimer?: unknown;
	private tickTimer?: unknown;
	private lastTick = 0;
	private calls = new Set<string>();
	private prompts = new Map<string, { prompt: VoicePrompt; answer: (v: unknown) => void; turn: number }>();
	/** The developer's committed turns: a question is answered only by a turn after it was asked. */
	private userTurns = 0;
	/** The words of the latest committed turn, once transcribed (text undefined: not transcribed). */
	private heardTurn: { turn: number; text?: string } = { turn: 0 };
	/** Which turn each committed item is. */
	private itemTurns = new Map<string, number>();
	/** What a local command did on a turn ("stop pi", "send"): the model's own call for it reports this. */
	private turnCommand?: { turn: number; cmd: TerminalCommand; out: Record<string, unknown> };
	/** Tools waiting for the latest turn's words. */
	private transcriptWaiters = new Set<() => void>();
	/** Requests to another session whose delivery herdr did not confirm, by target and words: never resent by the model. */
	private unconfirmed = new Map<string, number>();
	private screenSent = "";
	private lastStatus = "";
	private closed = false;
	private p: VoicePorts;
	private clock: Clock;

	constructor(ports: VoicePorts, sw: VoiceSwitch = "normal") {
		this.p = ports;
		this.clock = ports.clock ?? systemClock;
		this.sw = sw;
		this.gate = new TypingGate(undefined, () => this.clock.now());
		this.mono = new Monologue({
			clock: this.clock,
			send: (ev) => this.p.send(ev),
			turnDetection: () => this.p.turnDetection ?? DEFAULT_TURN_DETECTION,
			openDraft: ports.openDraft,
			silence: () => this.silence(),
			play: (e) => this.play(e),
			say: (line) => this.say(line),
			inject: (t) => this.inject(t),
			respond: () => this.respond(),
			quiet: () => this.sw === "quiet",
			notify: (m) => this.p.pi.notify(m, "info"),
			// A change of phase may free what was held (pi's news after the draft closes).
			status: () => {
				this.status();
				this.flushSoon();
			},
			log: (e) => this.p.log?.(e),
		});
	}

	// ── lifecycle ──

	/** The data channel is open: start listening and the working tick. */
	open(): void {
		this.connected = true;
		this.play("listen");
		this.scheduleTick();
		this.status();
	}

	close(): void {
		this.closed = true;
		this.clock.clearTimeout(this.flushTimer);
		this.clock.clearTimeout(this.tickTimer);
		this.clock.clearTimeout(this.turn?.timer);
		this.mono.close();
		// Open dialogs stay open in the terminal; only the voice stops answering them.
		this.prompts.clear();
		for (const w of [...this.transcriptWaiters]) w();
	}

	// ── inputs from the terminal and pi ──

	/** A key in the terminal: holds speech and the working tick until the next pause. */
	key(): void {
		this.gate.key();
		if (this.queue.length || this.pauseSounds.length) this.flushSoon();
	}

	setPiBusy(busy: boolean): void {
		if (busy && !this.piBusy) this.lastTick = this.clock.now();
		this.piBusy = busy;
		this.status();
	}

	/**
	 * pi tells the developer something. Questions and failures sound at once; the words (and the done
	 * sound) wait for a pause in typing. Quiet keeps the sounds and drops the words.
	 */
	announce(kind: AnnounceKind, sentence: string, opts: { context?: string; promptId?: string } = {}): Route {
		const r = route(kind, this.sw);
		this.p.log?.({ announce: kind, sentence, route: r });
		if (r.soundNow) this.play(r.soundNow);
		if (r.soundAtPause) this.pauseSounds.push(r.soundAtPause);
		if (r.speak && sentence) {
			// A newer outcome replaces an unspoken older one; questions and failures all wait their turn.
			if (kind === "done") this.queue = this.queue.filter((q) => q.kind !== "done");
			this.queue.push({ kind, sentence, ...opts });
		}
		this.flushSoon();
		return r;
	}

	/** An extension dialog pi raised while voice mode is on: read out, answerable by voice. */
	ask(prompt: VoicePrompt, answer: (v: unknown) => void): void {
		this.prompts.set(prompt.id, { prompt, answer, turn: this.userTurns });
		this.announce("question", speakPrompt(prompt), { context: promptContext(prompt), promptId: prompt.id });
	}

	/** The dialog was answered (by voice or in the terminal) or dismissed. */
	closePrompt(id: string): void {
		this.prompts.delete(id);
		this.queue = this.queue.filter((q) => q.promptId !== id);
	}

	/** What "this" and "that" mean right now: told to the voice model when it changes, never spoken. */
	screen(editor: string, last: string): void {
		const e = unmark(editor).trim();
		const text = `SCREEN: ${e ? `the developer's editor holds: "${e.slice(0, 400)}"` : "the editor is empty"}. The last thing pi showed: ${last.trim().slice(0, 600) || "nothing yet"}`;
		if (text === this.screenSent) return;
		this.screenSent = text;
		this.inject(`[PI] ${text}`);
	}

	setSwitch(sw: VoiceSwitch): void {
		if (sw === this.sw) return;
		this.sw = sw;
		this.p.log?.({ switch: sw });
		if (sw === "quiet") this.silence();
		const instructions = this.p.instructions?.(sw);
		if (instructions) this.p.send({ type: "session.update", session: { type: "realtime", instructions } });
		this.p.onSwitch?.(sw);
		this.play("heard");
		this.status();
	}

	// ── parking ──

	/** The spoken words wait in the editor, marked, for the developer to finish; the voice stays silent. */
	park(words: string): void {
		const editor = this.p.pi.getEditorText();
		this.parked = { words };
		this.p.pi.setEditorText(parkLine(words, isParkedText(editor) ? "" : editor));
		this.p.pi.parkHint(true);
		this.p.log?.({ parked: words });
		this.status();
	}

	/** "Send": the editor's text goes to pi as one message, typed text verbatim. */
	sendParked(): boolean {
		const text = parkedMessage(this.p.pi.getEditorText());
		// Switched to another session: the parked request goes there (deliver sends it through herdr).
		if (!text) return false;
		this.p.pi.setEditorText("");
		this.clearPark();
		this.deliver(text, "now");
		return true;
	}

	/** Enter sent the parked line (the marker is stripped by the input hook); `remote`: to another session, not this pi. */
	parkSubmitted(remote = false): void {
		if (!this.parked) return;
		this.clearPark();
		if (!remote) this.setPiBusy(true);
		// The voice saw it parked: tell it it is gone, or it may try to send it again.
		this.inject(`[PI] The parked request was sent with Enter${this.remote() ? ` to ${this.remote()}` : ""}; nothing is parked now.`);
	}

	/** Esc: the spoken segment becomes ordinary editable text. */
	unpark(): boolean {
		if (!this.parked) return false;
		this.p.pi.setEditorText(unmark(this.p.pi.getEditorText()));
		this.clearPark();
		return true;
	}

	/** The developer deleted the marker by hand: nothing is parked any more. */
	checkParked(): void {
		if (this.parked && !isParkedText(this.p.pi.getEditorText())) this.clearPark();
	}

	private clearPark(): void {
		this.parked = undefined;
		this.p.pi.parkHint(false);
		this.status();
	}

	// ── audio from the model ──

	/** Decoded model audio. Dropped in Quiet, after a barge-in until the next response, and when silent between turns. */
	onAudio(pcm: Buffer): void {
		if (this.dropAudio || this.sw === "quiet" || this.closed) return;
		if (!this.modelSpeaking && peak(pcm) < 64) return;
		if (this.held) {
			this.held.push(pcm);
			return;
		}
		this.write(pcm);
	}

	/** The developer's words were judged: what the reply already said may be heard. */
	private release(): void {
		const held = this.held;
		this.held = undefined;
		for (const pcm of held ?? []) this.write(pcm);
	}

	private write(pcm: Buffer): void {
		const now = this.clock.now();
		this.playingUntil = Math.max(now, this.playingUntil) + (pcm.length / 2 / RATE) * 1000;
		this.p.player.write(pcm);
	}

	private play(name: Earcon): void {
		if (this.closed) return;
		this.write(this.p.earcon(name));
	}

	/** Stops the voice at once: kills buffered audio, cancels the response being generated. Never stops pi. */
	private silence(): void {
		this.p.player.flush();
		this.playingUntil = 0;
		this.dropAudio = true;
		this.held = undefined;
		if (this.responseActive) this.p.send({ type: "response.cancel" });
		else if (this.requested) this.cancelOnCreate = true;
		this.wantResponse = false;
		this.pendingSay = undefined;
	}

	// ── realtime events ──

	onRealtime(ev: any): void {
		if (this.closed || !ev?.type) return;
		if (!/delta$/.test(ev.type)) this.p.log?.({ ev: ev.type, ...pick(ev) });
		switch (ev.type) {
			case "input_audio_buffer.speech_started":
				this.userSpeaking = true;
				this.mono.speechStarted();
				// Barge-in. The server has already cleared its output audio (even with interrupt_response
				// false); kill what is buffered here, and cancel only a response that is still being
				// generated. Never output_audio_buffer.clear: the server did that, and a second clear errors.
				if (this.modelSpeaking || this.clock.now() < this.playingUntil || this.responseActive || this.requested) {
					this.p.log?.({ bargeIn: true, responseActive: this.responseActive, modelSpeaking: this.modelSpeaking });
					this.silence();
				}
				break;
			case "input_audio_buffer.speech_stopped": {
				this.userSpeaking = false;
				this.mono.speechStopped();
				// Their turn is not over until its words are judged: nothing of ours starts in between.
				if (!this.turn) {
					const gap: { responded: boolean; timer?: unknown } = { responded: false };
					gap.timer = this.clock.setTimeout(() => {
						if (this.turn !== gap) return;
						this.turn = undefined;
						this.flushSoon();
					}, TRANSCRIPT_WAIT_MS);
					this.turn = gap;
				}
				break;
			}
			case "input_audio_buffer.committed": {
				this.userTurns++;
				if (ev.item_id) {
					this.itemTurns.set(String(ev.item_id), this.userTurns);
					if (this.itemTurns.size > 50) this.itemTurns.delete(this.itemTurns.keys().next().value!);
				}
				this.clock.clearTimeout(this.turn?.timer);
				// A draft is open: no reply is asked for, ever; the words go to the draft (or are a command).
				if (this.mono.active) {
					this.turn = undefined;
					break;
				}
				// The reply is asked for at once, but nothing of it is heard until the words are judged here
				// (parking, "send", the switches, a cough): the voice never starts talking over a request that
				// must stay silent, and costs no latency when the transcript is first (it usually is). Not
				// forever: without words in time, the reply plays.
				const turn: { item?: string; responded: boolean; timer?: unknown } = { item: ev.item_id, responded: true };
				this.held = [];
				turn.timer = this.clock.setTimeout(() => {
					if (this.turn !== turn) return;
					this.turn = undefined;
					this.release();
					this.flushSoon();
				}, TRANSCRIPT_WAIT_MS);
				this.turn = turn;
				this.respond();
				break;
			}
			case "conversation.item.input_audio_transcription.completed":
			case "conversation.item.input_audio_transcription.failed": {
				const text = ev.type.endsWith("failed") ? undefined : String(ev.transcript ?? "").trim();
				const heardTurn = (ev.item_id && this.itemTurns.get(String(ev.item_id))) || this.userTurns;
				if (heardTurn === this.userTurns) this.heardTurn = { turn: heardTurn, text };
				if (this.mono.active) {
					this.clock.clearTimeout(this.turn?.timer);
					this.turn = undefined;
					this.held = undefined;
					if (text === undefined) {
						this.p.log?.({ draft: "a turn could not be transcribed" });
						this.mono.missed();
					} else if (text) this.heard(text, false);
					break;
				}
				const turn = this.turn;
				if (turn && turn.item && ev.item_id && turn.item !== ev.item_id) break;
				this.clock.clearTimeout(turn?.timer);
				this.turn = undefined;
				const responded = !!turn?.responded;
				// A failed transcription: the model still heard the audio; let it answer.
				const handled = text === undefined ? false : this.heard(text, responded);
				if (!handled) this.release();
				if (!handled && !responded) this.respond();
				// A reply asked for while they were talking (a tool result, a SAY) goes now.
				else if (this.wantResponse) this.respond();
				break;
			}
			case "response.created":
				this.requested = false;
				this.responseActive = true;
				this.dropAudio = false;
				if (this.cancelOnCreate) {
					this.cancelOnCreate = false;
					this.dropAudio = true;
					this.p.send({ type: "response.cancel" });
				}
				break;
			case "response.done":
				this.requested = false;
				this.responseActive = false;
				if (ev.response?.status === "failed") this.p.pi.notify(`Voice: ${ev.response?.status_details?.error?.message ?? "response failed"}`, "warning");
				if (this.wantResponse) this.respond();
				break;
			case "output_audio_buffer.started":
				this.modelSpeaking = true;
				break;
			case "output_audio_buffer.stopped":
				// Said to the end, not interrupted: the developer listened, so what follows is a new exchange.
				if (this.modelSpeaking) this.mono.voiceDone();
				this.modelSpeaking = false;
				break;
			case "output_audio_buffer.cleared":
				this.modelSpeaking = false;
				break;
			case "response.output_audio_transcript.done": {
				this.lastSpoken = String(ev.transcript ?? "");
				// Quiet: the voice's own answer (to something asked directly) is shown, since it wasn't heard.
				if (this.sw === "quiet" && this.lastSpoken.trim()) this.p.pi.notify(`voice: ${this.lastSpoken.trim()}`, "info");
				break;
			}
			case "response.function_call_arguments.done":
				void this.runCall(ev.call_id, ev.name, ev.arguments);
				break;
			case "error": {
				const m = String(ev.error?.message ?? "");
				if (/active response/i.test(m) && !/no active response|not active/i.test(m)) this.wantResponse = true;
				break;
			}
		}
		// After the words were judged (a local command has run): tools waiting for them may go on.
		if (ev.type.startsWith("conversation.item.input_audio_transcription.")) for (const w of [...this.transcriptWaiters]) w();
		this.status();
		this.flushSoon();
	}

	/**
	 * The words of the latest committed turn, waiting for its transcript when it is still coming (not
	 * forever). undefined: not transcribed in time, or nothing said yet.
	 */
	private async latestWords(): Promise<string | undefined> {
		const ready = () => this.closed || this.heardTurn.turn >= this.userTurns;
		if (!ready()) {
			await new Promise<void>((resolve) => {
				let timer: unknown;
				const done = () => {
					this.transcriptWaiters.delete(check);
					this.clock.clearTimeout(timer);
					resolve();
				};
				const check = () => {
					if (ready()) done();
				};
				timer = this.clock.setTimeout(done, TRANSCRIPT_WAIT_MS * 4);
				this.transcriptWaiters.add(check);
			});
		}
		return this.heardTurn.turn === this.userTurns ? this.heardTurn.text : undefined;
	}

	/** What the local command did on the latest turn, when it was this one. */
	private commandOnLatestTurn(cmd: TerminalCommand): Record<string, unknown> | undefined {
		const c = this.turnCommand;
		return c && c.turn === this.userTurns && c.cmd === cmd ? c.out : undefined;
	}

	/**
	 * The developer's words, before the model replies. Returns true when handled here: noise and
	 * listening sounds, local commands, and requests that point at something still to come.
	 */
	private heard(text: string, responded: boolean): boolean {
		const take = () => {
			if (responded) this.silence();
			return true;
		};
		if (isBackchannel(text)) return take();
		const editor = this.p.pi.getEditorText();
		const cmd = parseTerminalCommand(text);
		if (this.mono.active) {
			// The voice's own controls still work; everything else is the draft's (content, answers, "send it").
			if (cmd && cmd !== "send") return this.command(text, cmd, editor, take);
			this.mono.turn(text);
			return true;
		}
		const handled = this.command(text, cmd, editor, take);
		if (handled) this.mono.handoff();
		else this.mono.track(text);
		return handled;
	}

	private command(text: string, cmd: ReturnType<typeof parseTerminalCommand>, editor: string, take: () => boolean): boolean {
		if (cmd === "send" && (this.parked || unmark(editor).trim())) {
			if (this.parked) this.sendParked();
			else {
				this.p.pi.setEditorText("");
				this.deliver(editor.trim(), "now");
			}
			this.turnCommand = { turn: this.userTurns, cmd, out: { sent: true } };
			return take();
		}
		if (cmd === "stopTalking") return take();
		if (cmd === "stopPi") {
			take();
			this.turnCommand = { turn: this.userTurns, cmd, out: this.stopPi() };
			return true;
		}
		if (cmd === "quiet" || cmd === "eyesFree" || cmd === "normal") {
			take();
			this.setSwitch(cmd === "eyesFree" ? "eyes-free" : cmd);
			return true;
		}
		if (pointsAhead(text, !this.parked && !!unmark(editor).trim())) {
			take();
			this.park(text);
			return true;
		}
		return false;
	}

	/** Explicit "stop pi" / "cancel that": stops pi's work, or drops a parked request when pi is idle. */
	private stopPi(): { stopped: boolean; note?: string } {
		// Switched to another session: a parked request is dropped here, otherwise that session is stopped.
		if (this.remote() && !this.parked) {
			void this.p
				.targets!.stop()
				.then((out) => this.p.log?.({ stopRemote: out }))
				.catch((e) => this.p.log?.({ stopRemote: "failed", error: String(e?.message ?? e) }));
			this.play("off");
			return { stopped: true, note: `stopping ${this.remote()}` };
		}
		if (!this.p.pi.isIdle() && !this.remote()) {
			this.p.pi.abort();
			this.play("off");
			return { stopped: true };
		}
		if (this.parked) {
			this.p.pi.setEditorText("");
			this.clearPark();
			this.play("off");
			return { stopped: false, note: "the parked request was dropped" };
		}
		return { stopped: false, note: "pi is not working" };
	}

	/**
	 * response.create, deferred while one is in flight or the developer is talking. With `say`, the
	 * response says exactly that line: it carries its own instructions (sayInstructions), so the voice
	 * doesn't paraphrase it. While a draft is open the voice says only such lines.
	 */
	respond(say?: string): void {
		if (say !== undefined) this.pendingSay = say;
		else if (this.mono.active && this.pendingSay === undefined) return;
		if (this.responseActive || this.requested || this.userSpeaking) {
			this.wantResponse = true;
			return;
		}
		this.wantResponse = false;
		this.requested = true;
		const line = this.pendingSay;
		this.pendingSay = undefined;
		if (line === undefined) return this.p.send({ type: "response.create" });
		const instructions = this.p.sayInstructions?.(line) ?? sayInstructions(line);
		this.p.send({ type: "response.create", response: { instructions, tool_choice: "none" } });
	}

	/** A line of the draft's (the read-back, a question), said exactly at the next pause. */
	say(line: string): void {
		if (!line.trim() || this.sw === "quiet") return;
		this.queue.push({ kind: "say", sentence: line.trim(), own: true });
		this.flushSoon();
	}

	/** The draft was sent (Enter or "send it"): to pi, or to the other session when switched. */
	sendDraft(markdown: string): void {
		this.deliver(markdown, "now");
	}

	private inject(text: string): void {
		this.p.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
	}

	/** Speech waits for a pause: no keys for a moment, nobody talking, no reply in flight. */
	private flushSoon(): void {
		this.clock.clearTimeout(this.flushTimer);
		if (this.closed || (!this.queue.length && !this.pauseSounds.length)) return;
		const wait = this.gate.wait();
		if (wait > 0) {
			this.flushTimer = this.clock.setTimeout(() => this.flushSoon(), wait);
			return;
		}
		if (this.userSpeaking || this.turn || this.modelSpeaking || this.responseActive || this.requested) return; // retried on the next event
		// While a monologue is being drafted the voice is silent: pi's news (and its done sound) waits for the draft.
		const holding = this.mono.composing;
		if (!holding) for (const s of this.pauseSounds.splice(0)) this.play(s);
		if (!this.queue.length) return;
		if (this.sw === "quiet") {
			this.queue = [];
			return;
		}
		const items = holding ? this.queue.filter((q) => q.own) : this.queue.splice(0);
		if (holding) this.queue = this.queue.filter((q) => !q.own);
		if (!items.length) return;
		const say = items.map((i) => i.sentence).join(" ");
		const context = items
			.map((i) => i.context)
			.filter(Boolean)
			.join("\n");
		this.p.log?.({ say });
		this.inject(`[PI] SAY: "${say}"${context ? `\n${context}` : ""}`);
		this.respond(say);
	}

	/** The soft working tick while pi works: never while typing, talking or in Quiet. */
	private scheduleTick(): void {
		this.clock.clearTimeout(this.tickTimer);
		if (this.closed) return;
		this.tickTimer = this.clock.setTimeout(() => {
			const now = this.clock.now();
			if (
				this.piBusy &&
				this.sw !== "quiet" &&
				!this.mono.composing &&
				!this.gate.typing(now) &&
				!this.modelSpeaking &&
				!this.userSpeaking &&
				!this.turn &&
				now >= this.playingUntil &&
				now - this.lastTick >= TICK_MS
			) {
				this.lastTick = now;
				this.play("working");
			}
			this.scheduleTick();
		}, 1000);
	}

	status(): VoiceStatus {
		const target = this.remote();
		const s: VoiceStatus = {
			state: !this.connected ? "connecting" : this.modelSpeaking ? "speaking" : this.piBusy ? "working" : "listening",
			sw: this.sw,
			parked: !!this.parked,
			...(target ? { target } : {}),
			...(this.mono?.active ? { draft: this.mono.phase as Exclude<MonologuePhase, "off"> } : {}),
		};
		const key = JSON.stringify(s);
		if (key !== this.lastStatus) {
			this.lastStatus = key;
			this.p.onStatus?.(s);
		}
		return s;
	}

	// ── tools ──

	/** The other session the voice talks to, or undefined for this pi. */
	remote(): string | undefined {
		return this.p.targets?.label();
	}

	/**
	 * A request for the other session (a parked line sent with Enter or "send"): sent through herdr;
	 * when it did not go, the voice says why. Never resent.
	 */
	async sendRemote(text: string): Promise<Record<string, unknown>> {
		const targets = this.p.targets;
		if (!targets?.label()) return { error: "no other session" };
		this.play("heard");
		const label = targets.label();
		const out = await targets.ask(text).catch((e: any) => ({ delivered: false, error: String(e?.message ?? e) }) as Record<string, unknown>);
		this.p.log?.({ deliverRemote: text, out });
		if (out.delivered === "unconfirmed") this.rememberUnconfirmed(label, text);
		if (out.delivered !== "prompt" && !this.closed) {
			this.inject(`[PI] The request for ${targets.label()} ${out.delivered === "unconfirmed" ? "may not have arrived (not resent)" : "was not sent"}: ${String(out.note ?? out.error ?? "")} Tell the developer in a few words.`);
			this.respond();
		}
		return out;
	}

	private unconfirmedKey(target: string | undefined, text: string): string {
		return `${target ?? ""}\n${norm(text)}`;
	}

	private rememberUnconfirmed(target: string | undefined, text: string): void {
		const now = this.clock.now();
		for (const [k, at] of this.unconfirmed) if (now - at >= UNCONFIRMED_MS) this.unconfirmed.delete(k);
		this.unconfirmed.set(this.unconfirmedKey(target, text), now);
	}

	private isUnconfirmed(target: string, text: string): boolean {
		const at = this.unconfirmed.get(this.unconfirmedKey(target, text));
		return at !== undefined && this.clock.now() - at < UNCONFIRMED_MS;
	}

	/** A complete request goes to pi at once: a prompt when idle, steering when busy; to the other session when switched. */
	private deliver(text: string, when: "now" | "after"): "prompt" | "steer" | "followUp" | "remote" {
		if (this.remote()) {
			void this.sendRemote(text).catch(() => {});
			return "remote";
		}
		this.mono.handoff();
		const how = this.p.pi.isIdle() ? "prompt" : when === "after" ? "followUp" : "steer";
		this.p.pi.send(text, how === "prompt" ? undefined : how);
		this.p.log?.({ deliver: text, how });
		this.setPiBusy(true);
		this.play("heard");
		return how;
	}

	async runCall(callId: string, name: string, rawArgs: string): Promise<void> {
		if (!callId || this.calls.has(callId)) return;
		this.calls.add(callId);
		let args: any = {};
		try {
			args = JSON.parse(rawArgs || "{}");
		} catch {}
		let out: Record<string, unknown>;
		let reply = true;
		try {
			({ out, reply } = await this.tool(name, args));
		} catch (e: any) {
			out = { error: String(e?.message ?? e) };
		}
		if (this.closed) return;
		// A tool answered (status, a switch, a request): the conversation moved on from what was said before.
		if (name !== "draft" && name !== "remain_silent") this.mono.handoff();
		this.p.log?.({ tool: name, args, out });
		this.p.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(out) } });
		if (reply) this.respond();
	}

	private async tool(name: string, args: any): Promise<{ out: Record<string, unknown>; reply: boolean }> {
		const pi = this.p.pi;
		switch (name) {
			case "ask_pi": {
				const text = String(args.request ?? "").trim();
				if (!text) return { out: { error: "empty request" }, reply: true };
				// The model's own judgement is not trusted with parking: words that point ahead always park.
				if (pointsAhead(text, !this.parked && !!unmark(pi.getEditorText()).trim())) {
					this.silence();
					this.park(text);
					return { out: { parked: true, note: "It waits in the editor for the developer to finish typing. Say nothing." }, reply: false };
				}
				const target = this.remote();
				if (target) {
					// Delivery not confirmed a moment ago: it may have arrived, so the model never sends it again.
					if (this.isUnconfirmed(target, text))
						return {
							out: {
								delivered: false,
								error: `Not sent again: this request went to ${target} moments ago and herdr did not confirm it, so it may have arrived. Tell the developer to check that session's screen.`,
							},
							reply: true,
						};
					// Another session: herdr's answer decides whether the voice says anything (not sent, unconfirmed).
					this.play("heard");
					const out = await this.p.targets!.ask(text);
					if (out.delivered === "unconfirmed") this.rememberUnconfirmed(target, text);
					return { out, reply: out.delivered !== "prompt" };
				}
				const how = this.deliver(text, args.when === "after" ? "after" : "now");
				const note = how === "prompt" ? "pi started working on it" : how === "steer" ? "pi is busy; the request steers its current work" : "queued until pi finishes";
				// Delegated: say nothing more unless it steered or queued; the working tick carries the wait.
				return { out: { delivered: how, note }, reply: how !== "prompt" };
			}
			case "answer_question": {
				const id = args.id ? String(args.id) : "";
				const open = [...this.prompts.values()];
				if (!open.length) return { out: { error: "pi is not waiting on a question" }, reply: true };
				const list = open.map((e) => `id ${e.prompt.id}: ${e.prompt.title}`).join("; ");
				// Several open (this pi's and another session's): which one is never guessed.
				if (!id && open.length > 1)
					return { out: { error: `Not answered: ${open.length} questions are open (${list}). Ask which one they mean, then answer it with its id.` }, reply: true };
				const entry = id ? this.prompts.get(id) : open[0];
				if (!entry) return { out: { error: `Not answered: no open question has id ${id}. Open: ${list}.` }, reply: true };
				// The model never answers for the developer: only something they said after the question counts.
				if (this.userTurns <= entry.turn)
					return { out: { error: "Not answered: the developer has not answered yet. Put the question to them and wait for their answer." }, reply: true };
				const r = answerFor(entry.prompt, String(args.answer ?? ""));
				if ("needConfirm" in r) return { out: { error: `Not answered: this is an irreversible action. Ask the developer to confirm by saying "yes, ${r.needConfirm}".` }, reply: true };
				if ("unclear" in r) return { out: { error: "Not answered: the answer does not fit the question. Ask again briefly." }, reply: true };
				this.prompts.delete(entry.prompt.id);
				entry.answer(r.value);
				this.play("heard");
				return { out: { answered: r.value === undefined ? "cancelled" : r.value }, reply: false };
			}
			case "stop_pi": {
				// Never on the model's judgement alone: the turn's own words must be an explicit "stop pi"
				// ("Stop." stops the voice, never pi). That command has already run locally; report it.
				const words = await this.latestWords();
				if (this.closed) return { out: { stopped: false }, reply: false };
				if (words === undefined || parseTerminalCommand(words) !== "stopPi")
					return {
						out: { stopped: false, note: 'Not stopped: only the developer saying "stop pi" or "cancel that" stops pi. Interrupting you never does. Say nothing about it.' },
						reply: false,
					};
				return { out: this.commandOnLatestTurn("stopPi") ?? this.stopPi(), reply: false };
			}
			case "pi_status":
				return { out: { speech: this.remote() ? await this.p.targets!.status() : pi.status() }, reply: true };
			case "pi_details": {
				const last = this.p.targets?.last;
				if (this.remote() && last)
					return { out: { from: last.label, answer: last.text.slice(0, 3000), note: "Answer their question from this, briefly, for the ear; never read it out." }, reply: true };
				return { out: { speech: await pi.details(String(args.topic ?? "")) }, reply: true };
			}
			case "list_sessions": {
				if (!this.p.targets) return { out: { error: "other sessions are not available here" }, reply: true };
				return { out: await this.p.targets.list(args.machine ? String(args.machine) : undefined), reply: true };
			}
			case "switch_session": {
				if (!this.p.targets) return { out: { error: "other sessions are not available here" }, reply: true };
				const out = await this.p.targets.switchTo(String(args.name ?? ""));
				if (out.switched) this.play("heard");
				this.status();
				return { out, reply: true };
			}
			case "park": {
				this.silence();
				const words = String(args.words ?? "").trim();
				// Already parked from the transcript: the model's call (often cut short by that very cancel, its
				// arguments truncated) must not replace the words in the editor.
				if (this.parked && (!words || norm(words) === norm(this.parked.words))) return { out: { parked: true }, reply: false };
				this.park(words || "…");
				return { out: { parked: true }, reply: false };
			}
			case "send_parked": {
				// A parked request never sends itself: only the developer's "send" (or Enter) does.
				const words = await this.latestWords();
				if (this.closed) return { out: { sent: false }, reply: false };
				const said = words !== undefined && parseTerminalCommand(words) === "send";
				if (said && this.commandOnLatestTurn("send")) return { out: { sent: true }, reply: false };
				if (this.parked && !said)
					return { out: { sent: false, note: 'Not sent: the parked request waits for the developer to finish; it goes when they say "send" or press Enter. Say nothing.' }, reply: false };
				if (this.sendParked()) return { out: { sent: true }, reply: false };
				// Nothing parked (already sent with Enter): the voice must not swallow what it was about to say.
				return { out: { sent: false, note: "Nothing is parked; it was already sent. If a [PI] SAY is waiting, say it now." }, reply: true };
			}
			case "voice_setting": {
				const s = String(args.setting ?? "");
				if (s === "quiet" || s === "eyes-free" || s === "normal") this.setSwitch(s);
				return { out: { setting: this.sw }, reply: false };
			}
			case "draft": {
				// The voice model recognised composing: from now on what they say goes into a draft, not the conversation.
				if (!this.mono.start("intent", args.shape ? String(args.shape) : undefined)) return { out: { error: "drafts are not available here" }, reply: true };
				return { out: { drafting: true, note: "The draft is open on their screen and collects what they say. Say nothing." }, reply: false };
			}
			case "remain_silent":
				return { out: { ok: true }, reply: false };
			default:
				return { out: { error: `unknown tool ${name}` }, reply: true };
		}
	}
}

/** How long a request whose delivery herdr did not confirm is remembered (the model may not resend it). */
export const UNCONFIRMED_MS = 2 * 60_000;

function peak(pcm: Buffer): number {
	let p = 0;
	for (let i = 0; i + 1 < pcm.length; i += 2) {
		const v = Math.abs(pcm.readInt16LE(i));
		if (v > p) p = v;
	}
	return p;
}

/** The fields of a realtime event worth a log line. */
function pick(ev: any): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	if (ev.transcript) o.transcript = ev.transcript;
	if (ev.name) o.name = ev.name;
	if (ev.arguments) o.arguments = ev.arguments;
	if (ev.response?.status) o.status = ev.response.status;
	if (ev.error) o.error = ev.error?.message ?? ev.error;
	if (ev.item_id) o.item = ev.item_id;
	return o;
}
