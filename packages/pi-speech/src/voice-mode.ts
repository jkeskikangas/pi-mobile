// Terminal voice mode: talk with pi through headphones while its full answers stay on screen.
//
//   /voice  or alt+v          start or stop voice mode for this pi session
//   /voice quiet|eyes-free|normal   the two switches (also by voice: "go quiet", "I can't look")
//   /voice status             what is in use
//
// The rules (designs/voice-modalities.md): the voice says how it went and when you're needed, in one
// sentence, and everything else is text; that sentence starts pi's answer in the transcript as a "said"
// line. Speech waits until you stop typing. A spoken request that points at something to come is
// parked in the editor for you to finish. Interrupting the voice never stops pi.
//
// The pieces: rtc.ts (the realtime call), audio-io.ts (microphone, player), voice-session.ts (the
// conversation logic), earcons.ts, park.ts, dialogs.ts, and the same realtime session, ChatGPT sign-in
// and brief writer as the phone's voice mode.

import { appendFileSync, chmodSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Capture, openPlayer, type Player, startCapture } from "./audio-io.ts";
import { languageOf, loadVoiceConfig, saveVoiceConfig, speechDir, systemLanguage, type VoiceConfig } from "./config.ts";
import type { VoicePrompt } from "./dialogs.ts";
import { earconPcm } from "./earcons.ts";
import { type HerdrExec, HerdrTargets, herdrExec, type RemoteEntry } from "./herdr-targets.ts";
import { VoiceHost } from "./host.ts";
import { type Complete, registryComplete, sessionComplete } from "./model.ts";
import { isParkedText, unmark } from "./park.ts";
import { chooseVoice } from "./personas.ts";
import { DEFAULT_REALTIME_MODEL, type RealtimeCredentials, realtimeSession, sayInstructions, voiceInstructions } from "./realtime.ts";
import { connectRealtime, type RealtimeLink } from "./rtc.ts";
import {
	type Attention,
	brief,
	countWord,
	describeActivity,
	digestText,
	firstSentences,
	heuristicBrief,
	isSignificant,
	type RunDigest,
	runDigest,
	significantKind,
	speakable,
	terminalVoiceNote,
} from "./speech.ts";
import { VoiceDraft } from "./voice-draft.ts";
import { type AnnounceKind, type Clock, statusText, systemClock, VoiceSession, type VoiceStatus, type VoiceSwitch } from "./voice-session.ts";

const CLAIM = Symbol.for("pi-speech.voice");
const STATUS = "pi-speech-voice";
const HINT = "pi-speech-voice-park";
/** The custom entry that shows what the voice said, as the first line of pi's answer. */
export const SAID = "pi-speech-said";
/** The custom entry for another session (herdr): what was sent there, its answer, its questions. Never sent to the model. */
export const REMOTE = "pi-speech-remote";
/** pi's dialogs, wrapped once per ui object; the wrapper asks whichever voice mode is loaded now. */
const DIALOGS = Symbol.for("pi-speech.voice.dialogs");
const BRIEF_TIMEOUT_MS = 6000;
/** How long pi's shutdown waits for a voice mode that was still starting to let go of what it opened. */
const SHUTDOWN_WAIT_MS = 5000;

/** alt+v, except where pi uses it to paste images (Windows and WSL). */
export function voiceShortcut(platform = process.platform, env = process.env): "alt+v" | "alt+shift+v" {
	return platform === "win32" || env.WSL_DISTRO_NAME ? "alt+shift+v" : "alt+v";
}

export const attentionFor = (sw: VoiceSwitch): Attention => (sw === "eyes-free" ? "eyes-busy" : "glance");

/** Is this assistant message the final answer of a run (not a step before tool calls)? */
export function isFinalAnswer(m: any): boolean {
	if (m?.role !== "assistant") return false;
	if ((m.content ?? []).some((c: any) => c?.type === "toolCall")) return false;
	return m.stopReason === "stop" || m.stopReason === "length" || m.stopReason === "error";
}

export interface AnswerOutput {
	kind: AnnounceKind;
	/** What the voice says ("" in Quiet: sounds only). */
	sentence: string;
	/** The said line shown above the answer; only when something is spoken. */
	said?: string;
	/** For the voice's follow-up answers, never read out. */
	context: string;
	/** "The last thing pi showed", for "this" and "that". */
	last: string;
}

/**
 * The output rule for one finished answer: one spoken sentence (the brief writer, for the terminal),
 * the same sentence as the said line, and the kind that picks the sound. A slow model falls back to
 * the answer's first sentence: the answer waits for this sentence before it shows as final.
 */
export async function answerOutput(m: any, branch: readonly any[], sw: VoiceSwitch, complete?: Complete, timeoutMs = BRIEF_TIMEOUT_MS): Promise<AnswerOutput> {
	const text = (m.content ?? [])
		.filter((x: any) => x?.type === "text")
		.map((x: any) => x.text)
		.join("\n");
	const last = firstSentences(speakable(text), 3).slice(0, 500) || (m.stopReason === "error" ? `pi stopped with an error: ${m.errorMessage ?? ""}` : "");
	const spoken = (kind: AnnounceKind, sentence: string, context: string): AnswerOutput =>
		sw === "quiet" ? { kind, sentence: "", context, last } : { kind, sentence, said: sentence, context, last };
	if (m.stopReason === "error") return spoken("failed", "pi stopped with an error; the details are on screen.", `ERROR: ${String(m.errorMessage ?? "").slice(0, 300)}`);
	const d = runDigest([...branch, { type: "message", message: m }]);
	const report = digestText(d);
	const context = `REPORT (for follow-up questions, do not read out):\n${report.slice(0, 6000)}`;
	const failed = /SIGNIFICANT ACTION FAILED/.test(report);
	if (sw === "quiet") return { kind: failed ? "failed" : "done", sentence: "", context, last };
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	let speech: string;
	try {
		speech = (await brief(d, attentionFor(sw), complete, ctrl.signal, "terminal")).speech;
	} catch {
		speech = heuristicBrief(d, attentionFor(sw), "terminal").speech;
	} finally {
		clearTimeout(timer);
	}
	return spoken(failed ? "failed" : /\?\s*$/.test(speech) ? "question" : "done", speech, context);
}

/** The one spoken sentence for another session's run: the same brief writer, the same fallback. */
export async function remoteBrief(d: RunDigest, sw: VoiceSwitch, complete?: Complete, timeoutMs = BRIEF_TIMEOUT_MS): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return (await brief(d, attentionFor(sw), complete, ctrl.signal, "terminal")).speech;
	} catch {
		return heuristicBrief(d, attentionFor(sw), "terminal").speech;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The language of the realtime session's input transcription: the configured one, else the system's.
 * Without it the transcriber guesses per turn, and a one-word reply ("Green.") came back as Japanese.
 */
export function transcriptionLanguage(cfg: Pick<VoiceConfig, "locale">, system: () => string | undefined = systemLanguage): string | undefined {
	return languageOf(cfg.locale) ?? system();
}

/** The lines of a REMOTE entry, labelled with the session (theme-free, for tests). */
export function remoteLines(e: RemoteEntry): { head: string; label: string; body: string[] } {
	const body = String(e.text ?? "").split("\n");
	if (e.kind === "sent") return { head: "→", label: e.target, body };
	if (e.kind === "question") return { head: "?", label: `${e.target} asks`, body };
	if (e.kind === "answer") return { head: e.said ? "said" : "←", label: e.target, body: e.said ? [e.said, ...body] : body };
	return { head: "·", label: e.target, body };
}

interface Active {
	session: VoiceSession;
	targets: HerdrTargets;
	link?: RealtimeLink;
	player?: Player;
	capture?: Capture;
	/** The draft a monologue became, while it is on screen. */
	draft?: VoiceDraft;
	unsubscribe?: () => void;
	last: string;
	tools: Map<string, { name: string; title: string; significant: boolean }>;
	runStartedAt: number;
	screenTimer?: unknown;
	/** Settles when start() has finished (on, failed, or abandoned and cleaned up). */
	starting?: Promise<void>;
}

type DialogKind = "select" | "confirm" | "input";
type DialogRace = <T>(spec: Omit<VoicePrompt, "id">, local: (signal: AbortSignal | undefined) => Promise<T>, opts: any) => Promise<T>;
/** On the ui object: its own dialogs, the wrappers put in their place, and the voice answering now. */
interface DialogSlot {
	orig: Record<DialogKind, any>;
	wrappers: Record<DialogKind, any>;
	race?: DialogRace;
}

/** What voice mode opens, injectable so tests drive start and stop without devices or network. */
export interface VoiceModeDeps {
	openPlayer(): Promise<Player>;
	connectRealtime(creds: RealtimeCredentials, session: Record<string, unknown>): Promise<RealtimeLink>;
	startCapture(onPcm: (pcm: Buffer) => void, onError: (message: string) => void): Promise<Capture>;
	credentials(): Promise<RealtimeCredentials | undefined>;
	hints(): Promise<string[]>;
	herdrExec: HerdrExec;
	clock: Clock;
}

export interface VoiceModeOptions {
	/** The model for a draft's finishing check (default: this session's model, never the fast one). */
	careful?: Complete;
	deps?: Partial<VoiceModeDeps>;
}

/** `complete`: the fast model (briefs, the draft's live updates); the session's model otherwise. */
export function registerVoiceMode(pi: ExtensionAPI, complete?: Complete, opts: VoiceModeOptions = {}): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[CLAIM]) return;
	const claim = {};
	g[CLAIM] = claim;
	let ctx: ExtensionContext | undefined;
	/** The voice from the moment it starts (connecting) until it stops. */
	let active: Active | undefined;
	const done = complete ?? registryComplete(() => ctx!, () => loadVoiceConfig().model);
	// The finishing check reconciles the whole draft: the session's model, even when pi-mobile hands a fast one.
	const careful = opts.careful ?? sessionComplete(() => ctx!);
	const host = new VoiceHost({ ctx: () => ctx!, config: () => loadVoiceConfig(), stateDir: speechDir, complete: done });
	const deps: VoiceModeDeps = {
		openPlayer: () => openPlayer(),
		connectRealtime: (creds, s) => connectRealtime(creds, s),
		startCapture,
		credentials: () => host.credentials(),
		hints: () => host.hints(),
		herdrExec: herdrExec(),
		clock: systemClock,
		...opts.deps,
	};
	const clock = deps.clock;
	/** The voice once it is connected and listening (not while it is still starting). */
	const running = () => (active?.session.connected ? active : undefined);
	const logPath = process.env.PI_SPEECH_VOICE_LOG;
	let logReady = false;
	const log = (entry: Record<string, unknown>) => {
		if (!logPath) return;
		try {
			// Transcripts and requests: readable by the developer only.
			appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
			if (!logReady) {
				logReady = true;
				chmodSync(logPath, 0o600);
			}
		} catch {}
	};

	// The said line: what the voice said about an answer, in the voice colour, kept in the transcript
	// (a custom entry: shown, persisted, never sent to the model). Older pi versions and test fakes have
	// no entry renderers: the entry is then just not drawn.
	if (typeof pi.registerEntryRenderer === "function")
		pi.registerEntryRenderer<{ text: string }>(SAID, (entry, _o, theme) => {
			const text = entry.data?.text;
			if (!text) return undefined;
			return new Text(`${theme.fg("accent", theme.bold("said"))}  ${theme.fg("accent", text)}`, 1, 0);
		});
	// Another session's lines, labelled with it: "→ api @devbox  the request", "said api @devbox  …" and its answer.
	if (typeof pi.registerEntryRenderer === "function")
		pi.registerEntryRenderer<RemoteEntry>(REMOTE, (entry, _o, theme) => {
			if (!entry.data?.target) return undefined;
			const { head, label, body } = remoteLines(entry.data);
			const said = entry.data.kind === "answer" && !!entry.data.said;
			const [first = "", ...rest] = body;
			const top = `${theme.fg("accent", theme.bold(head))} ${theme.fg("dim", label)}  ${said ? theme.fg("accent", first) : first}`;
			return new Text([top, ...rest].join("\n"), 1, 0);
		});

	const switchOf = (cfg: VoiceConfig = loadVoiceConfig()): VoiceSwitch => cfg.voiceSwitch ?? "normal";
	const project = () => (ctx?.cwd ?? process.cwd()).split("/").pop() || "project";

	const instructionsFor = (sw: VoiceSwitch, hints: string[], delivery: string) =>
		voiceInstructions(
			attentionFor(sw),
			project(),
			[
				hints.length ? `Names in this project you may hear: ${hints.slice(0, 60).join(", ")}.` : "",
				sw === "quiet" ? "QUIET is on: the developer hears nothing you say (only sounds). Do not speak unless they ask you something directly; your tools work as usual." : "",
			]
				.filter(Boolean)
				.join("\n"),
			delivery,
			"terminal",
		);

	const setStatus = (s: VoiceStatus | undefined) => {
		if (!ctx?.hasUI) return;
		if (!s) return ctx.ui.setStatus(STATUS, undefined);
		const t = ctx.ui.theme;
		const dot = s.state === "speaking" ? t.fg("accent", "◉") : s.state === "connecting" ? t.fg("dim", "○") : t.fg("accent", "●");
		ctx.ui.setStatus(STATUS, `${dot} ${statusText(s)}`);
	};

	const parkHint = (on: boolean) => {
		if (!ctx?.hasUI) return;
		const to = active?.targets.label();
		ctx.ui.setWidget(HINT, on ? [ctx.ui.theme.fg("accent", `● spoken · Finish typing · Enter sends${to ? ` to ${to}` : ""} · Esc keeps it as plain text`)] : undefined);
	};

	const statusSpeech = (a: Active): string => {
		if (ctx!.isIdle()) return "pi is idle.";
		const mins = Math.round((Date.now() - a.runStartedAt) / 60_000);
		const took = mins >= 1 ? `for ${mins === 1 ? "a minute" : countWord(mins, "minute")}` : "for a few seconds";
		const tool = [...a.tools.values()].pop();
		return `Working ${took}${tool ? `, now ${describeActivity(tool.name, tool.title)}` : ""}.`;
	};

	const updateScreen = (a: Active) => {
		if (!ctx?.hasUI) return;
		a.session.checkParked();
		a.session.screen(ctx.ui.getEditorText(), a.last);
	};

	/** Closes what a voice holds: microphone, player, the call. Safe to call again (what is gone is skipped). */
	const release = async (a: Active) => {
		const { capture, player, link } = a;
		a.capture = undefined;
		a.player = undefined;
		a.link = undefined;
		capture?.stop();
		player?.close();
		await link?.close().catch(() => {});
	};

	/**
	 * Ends the voice, also one still starting (start() then closes whatever it obtains after this).
	 * `shutdown`: pi is going away (quit, /reload): only stop listening and close the views; nothing
	 * new runs on the old session (no finishing check for a draft, no notes on screen).
	 */
	const stop = async (message?: string, level: "info" | "warning" | "error" = "info", shutdown = false) => {
		const a = active;
		active = undefined;
		if (!a) return;
		log({ voice: "off", why: message ?? (shutdown ? "shutdown" : "stopped") });
		clock.clearTimeout(a.screenTimer);
		a.screenTimer = undefined;
		a.unsubscribe?.();
		a.unsubscribe = undefined;
		if (shutdown) a.draft?.discard();
		// A draft on screen is never lost with the voice: it finishes listening and waits for Enter or Esc.
		else a.draft?.orphan();
		// A parked line stays as plain text: the marker means something only while the voice is on.
		if (!shutdown && a.session.parked) a.session.unpark();
		a.targets.close();
		a.session.close();
		await release(a);
		if (!shutdown && ctx?.hasUI) {
			setStatus(undefined);
			ctx.ui.setWidget(HINT, undefined);
			if (message) ctx.ui.notify(message, level);
		}
	};

	const start = async (c: ExtensionContext) => {
		ctx = c;
		if (c.mode !== "tui") return c.ui.notify("Voice mode needs the interactive terminal.", "warning");
		if (active) return;
		const cfg = loadVoiceConfig();
		if (cfg.realtime === "off") return c.ui.notify("Voice mode is turned off in the voice config (realtime: off).", "warning");
		const sw = switchOf(cfg);
		const session = new VoiceSession(
			{
				send: (ev) => a.link?.send(ev),
				player: { write: (pcm) => a.player?.write(pcm), flush: () => a.player?.flush() },
				earcon: (name) => earconPcm(name),
				pi: {
					isIdle: () => ctx!.isIdle(),
					send: (text, deliverAs) => (deliverAs ? pi.sendUserMessage(text, { deliverAs }) : pi.sendUserMessage(text)),
					abort: () => ctx!.abort(),
					getEditorText: () => ctx!.ui.getEditorText(),
					setEditorText: (t) => ctx!.ui.setEditorText(t),
					notify: (m, l) => ctx!.ui.notify(m, l),
					status: () => statusSpeech(a),
					details: async (topic) => (await host.details({ topic, mode: attentionFor(a.session.sw) })).speech,
					parkHint,
				},
				instructions: (s) => instructionsFor(s, hints, delivery),
				onSwitch: (s) => saveVoiceConfig({ ...loadVoiceConfig(), voiceSwitch: s }),
				onStatus: setStatus,
				log,
				clock,
				targets: {
					label: () => a.targets.label(),
					ask: (text) => a.targets.ask(text),
					list: (m) => a.targets.list(m),
					switchTo: (n) => a.targets.switchTo(n),
					status: () => a.targets.status(),
					stop: () => a.targets.stop(),
					get last() {
						return a.targets.last;
					},
				},
				get turnDetection() {
					return turnDetection;
				},
				sayInstructions: (line) => sayInstructions(line, delivery),
				openDraft: (o, events) => {
					const d = new VoiceDraft(
						{
							ctx: ctx!,
							fast: done,
							careful,
							// Voice mode may have ended meanwhile: the draft then goes to this pi directly.
							send: (md) => (active === a ? a.session.sendDraft(md) : ctx!.isIdle() ? pi.sendUserMessage(md) : pi.sendUserMessage(md, { deliverAs: "steer" })),
							target: () => (active === a ? a.targets.label() : undefined),
							log,
						},
						o,
						{
							finish: events.finish,
							closed: (how) => {
								if (a.draft === d) a.draft = undefined;
								events.closed(how);
							},
						},
					);
					a.draft = d;
					return d;
				},
			},
			sw,
		);
		// Other sessions through herdr: on when pi runs inside herdr (HERDR_ENV=1) and the command works.
		const targets = new HerdrTargets({
			exec: deps.herdrExec,
			inHerdr: process.env.HERDR_ENV === "1",
			selfPane: process.env.HERDR_PANE_ID,
			brief: (d) => remoteBrief(d, session.sw, done),
			ask: (p, answer) => session.ask(p, answer),
			closePrompt: (id) => session.closePrompt(id),
			announce: (kind, sentence, opts) => session.announce(kind, sentence, opts),
			show: (entry) => pi.appendEntry(REMOTE, entry),
			quiet: () => session.sw === "quiet",
			onTarget: () => {
				session.status();
				if (session.parked) parkHint(true);
			},
			log,
		});
		const a: Active = { session, targets, last: "", tools: new Map(), runStartedAt: Date.now() };
		let hints: string[] = [];
		let delivery = "";
		let turnDetection: Record<string, unknown> | undefined;
		// From here the voice exists: alt+v, /voice, a lost call, a microphone error or pi's shutdown
		// stop it, even while it is still starting. After each wait below, a voice that was stopped
		// meanwhile goes no further, and what it obtained is closed (finally).
		active = a;
		const gone = () => active !== a;
		let settle!: () => void;
		a.starting = new Promise<void>((r) => (settle = r));
		setStatus(session.status());
		try {
			const creds = await deps.credentials();
			if (gone()) return;
			if (!creds) throw new Error("sign in to ChatGPT in pi (/login openai-codex) or set OPENAI_API_KEY");
			const voice = chooseVoice(cfg, undefined);
			delivery = voice.persona.delivery ?? "";
			hints = (await deps.hints().catch(() => [] as string[])).slice(0, 60);
			if (gone()) return;
			const s = realtimeSession({
				mode: attentionFor(sw),
				project: project(),
				model: cfg.realtimeModel || DEFAULT_REALTIME_MODEL,
				voice: voice.realtime,
				delivery,
				hints,
				language: transcriptionLanguage(cfg),
				// The terminal defaults to a fixed silence (about 1.5 s turns); semantic VAD sometimes waited 4-10 s.
				turnDetection: cfg.turnDetection === "semantic" ? "semantic" : "server",
				surface: "terminal",
			});
			s.instructions = instructionsFor(sw, hints, delivery);
			turnDetection = (s as any).audio?.input?.turn_detection;
			a.player = await deps.openPlayer();
			if (gone()) return;
			a.link = await deps.connectRealtime(creds, s);
			if (gone()) return;
			const link = a.link;
			log({ voice: "on", call: link.callId, player: a.player.target, switch: sw });
			link.onEvent((ev) => session.onRealtime(ev));
			link.onAudio((pcm) => session.onAudio(pcm));
			link.onClose((why) => {
				if (active === a) void stop(`Voice mode ended: ${why}.`, "warning");
			});
			session.setPiBusy(!c.isIdle());
			session.open();
			session.screen(c.ui.getEditorText(), "");
			a.unsubscribe = c.ui.onTerminalInput((data) => {
				if (active !== a) return undefined;
				a.session.key();
				// Esc turns a parked spoken segment into ordinary text (and does nothing else).
				if (data === "\x1b" && a.session.parked && isParkedText(ctx!.ui.getEditorText())) {
					a.session.unpark();
					return { consume: true };
				}
				clock.clearTimeout(a.screenTimer);
				a.screenTimer = clock.setTimeout(() => active === a && updateScreen(a), 1500);
				return undefined;
			});
			patchDialogs(c);
			a.capture = await deps.startCapture(
				(pcm) => a.link?.sendPcm(pcm),
				(msg) => {
					if (active === a) void stop(`Voice mode: ${msg}`, "error");
				},
			);
			if (gone()) return;
			c.ui.notify(`Voice mode on${sw === "normal" ? "" : ` (${sw})`}. Talk to pi; /voice or ${voiceShortcut()} ends it.`, "info");
		} catch (e: any) {
			if (!gone()) await stop(`Voice mode: ${e?.message ?? e}`, "error");
		} finally {
			// Stopped while starting: what was obtained after stop() ran is closed here.
			if (gone()) await release(a);
			settle();
		}
	};

	const toggle = async (c: ExtensionContext) => (active ? stop("Voice mode off.") : start(c));

	const setSwitch = (c: ExtensionContext, sw: VoiceSwitch) => {
		saveVoiceConfig({ ...loadVoiceConfig(), voiceSwitch: sw });
		if (active) active.session.setSwitch(sw);
		c.ui.notify(
			sw === "quiet" ? "Voice: quiet. Nothing is spoken; sounds still mark needs you, done and failed." : sw === "eyes-free" ? "Voice: eyes-free. Longer spoken briefs." : "Voice: normal.",
			"info",
		);
	};

	// ── pi's dialogs, answerable by voice while voice mode is on ──
	// Wrapped once per ui object; the wrapper asks the voice mode loaded now (`slot.race`), so after
	// /reload the new instance answers by voice, and shutdown puts pi's own dialogs back.
	let patchedUi: any;
	const race: DialogRace = <T>(spec: Omit<VoicePrompt, "id">, local: (signal: AbortSignal | undefined) => Promise<T>, opts: any): Promise<T> => {
		const a = running();
		if (!a || opts?.signal?.aborted) return local(opts?.signal);
		const ctrl = new AbortController();
		const signal = opts?.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
		const id = Math.random().toString(36).slice(2, 8);
		const byVoice = new Promise<{ v: T }>((resolve) => a.session.ask({ id, ...spec }, (v) => resolve({ v: v as T })));
		const inTerminal = local(signal).then((v) => ({ v }));
		inTerminal.catch(() => {});
		return Promise.race([inTerminal, byVoice]).then(
			(w) => {
				a.session.closePrompt(id);
				ctrl.abort();
				return w.v;
			},
			(e) => {
				a.session.closePrompt(id);
				throw e;
			},
		);
	};
	const patchDialogs = (c: ExtensionContext) => {
		const ui = c.ui as any;
		let slot: DialogSlot | undefined = ui[DIALOGS];
		if (!slot) {
			const orig = { select: ui.select, confirm: ui.confirm, input: ui.input };
			const s: DialogSlot = { orig, wrappers: {} as DialogSlot["wrappers"] };
			const via = <T>(spec: Omit<VoicePrompt, "id">, local: (signal: AbortSignal | undefined) => Promise<T>, opts: any): Promise<T> =>
				s.race ? s.race(spec, local, opts) : local(opts?.signal);
			s.wrappers = {
				select: (title: string, options: string[], opts?: any) =>
					via({ kind: "select", title, options: [...options] }, (signal) => orig.select.call(ui, title, options, { ...opts, signal }), opts),
				confirm: (title: string, message: string, opts?: any) =>
					via({ kind: "confirm", title, message }, (signal) => orig.confirm.call(ui, title, message, { ...opts, signal }), opts),
				input: (title: string, placeholder?: string, opts?: any) =>
					via({ kind: "input", title, placeholder }, (signal) => orig.input.call(ui, title, placeholder, { ...opts, signal }), opts),
			};
			Object.assign(ui, s.wrappers);
			ui[DIALOGS] = slot = s;
		}
		slot.race = race;
		patchedUi = ui;
	};
	const restoreDialogs = () => {
		const ui = patchedUi;
		patchedUi = undefined;
		const slot: DialogSlot | undefined = ui?.[DIALOGS];
		if (!slot) return;
		if (slot.race === race) slot.race = undefined;
		// Our wrappers are still the ones installed (nobody wrapped them since): pi's own go back.
		const ours = (Object.keys(slot.wrappers) as DialogKind[]).every((k) => ui[k] === slot.wrappers[k]);
		if (!slot.race && ours) {
			Object.assign(ui, slot.orig);
			delete ui[DIALOGS];
		}
	};

	// ── pi's events ──
	pi.on("session_start", async (_e, c) => {
		ctx = c;
	});
	pi.on("session_shutdown", async () => {
		const a = active;
		await stop(undefined, "info", true);
		// A voice still starting lets go of what it opens before the next one may claim the microphone.
		if (a?.starting) {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([a.starting, new Promise<void>((r) => (timer = setTimeout(r, SHUTDOWN_WAIT_MS)))]);
			clearTimeout(timer);
		}
		restoreDialogs();
		if (g[CLAIM] === claim) delete g[CLAIM];
	});
	pi.on("agent_start", async (_e, c) => {
		ctx = c;
		if (!active) return;
		active.runStartedAt = Date.now();
		active.tools.clear();
		active.session.setPiBusy(true);
	});
	pi.on("agent_settled", async () => {
		active?.session.setPiBusy(false);
	});
	pi.on("before_agent_start", async (e) => {
		const a = running();
		if (!a) return;
		return { systemPrompt: e.systemPrompt + terminalVoiceNote(attentionFor(a.session.sw)) };
	});
	// A parked line sent with Enter: pi gets the words without the marker, typed text verbatim. Only
	// while something is parked: text that merely starts with "● " is the developer's own.
	pi.on("input", async (e: any) => {
		const a = running();
		if (a?.session.parked && typeof e?.text === "string" && isParkedText(e.text)) {
			const text = unmark(e.text).trim();
			ctx?.ui.setWidget(HINT, undefined);
			// Switched to another session: the parked request goes there, not to this pi.
			const to = a.targets.label();
			if (to) {
				a.session.parkSubmitted(true);
				log({ input: text, source: e.source, parked: true, to });
				void a.session.sendRemote(text).catch((err: any) => log({ input: "remote send failed", error: String(err?.message ?? err) }));
				return { action: "handled" as const };
			}
			a.session.parkSubmitted();
			log({ input: text, source: e.source, parked: true });
			return { action: "transform" as const, text };
		}
		if (a) log({ input: e?.text, source: e?.source });
		return { action: "continue" as const };
	});
	pi.on("tool_execution_start", async (e) => {
		if (!active) return;
		const title = String(e.args?.command ?? e.args?.path ?? "").split("\n")[0].slice(0, 200);
		active.tools.set(e.toolCallId, { name: e.toolName, title, significant: /^(bash|shell|exec|run)/i.test(e.toolName) && isSignificant(title) });
	});
	pi.on("tool_execution_end", async (e) => {
		const a = running();
		if (!a) return;
		const t = a.tools.get(e.toolCallId);
		a.tools.delete(e.toolCallId);
		// A failed significant action (deploy, push, delete, production data) is spoken; routine failures are pi's business.
		if (t?.significant && e.isError) {
			const sentence = `Heads-up: ${significantKind(t.title)} failed.`;
			if (a.session.sw !== "quiet") pi.appendEntry(SAID, { text: sentence, kind: "failed" });
			a.session.announce("failed", sentence, { context: `A significant action FAILED: ${t.title}. pi is still working.` });
		}
	});
	// The answer: one spoken sentence, shown as the first line of pi's answer. Written here, before pi
	// shows the answer as final, so the said line lands above it in the transcript.
	pi.on("message_end", async (e, c) => {
		ctx = c;
		const a = running();
		if (!a || !isFinalAnswer(e.message)) return;
		const out = await answerOutput(e.message, (c.sessionManager.getBranch() as any[]) ?? [], a.session.sw, done);
		if (active !== a) return;
		a.last = out.last;
		if (out.said) pi.appendEntry(SAID, { text: out.said, kind: out.kind });
		log({ said: out.said, kind: out.kind });
		a.session.announce(out.kind, out.sentence, { context: out.context });
		updateScreen(a);
	});

	pi.registerShortcut(voiceShortcut(), { description: "Voice mode: talk with pi (start or stop)", handler: toggle });

	pi.registerCommand("voice", {
		description: `Voice mode: talk with pi through headphones (${voiceShortcut()}). quiet | eyes-free | normal | status`,
		getArgumentCompletions: (prefix) =>
			["quiet", "eyes-free", "normal", "status"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().toLowerCase();
			if (!sub) return toggle(c);
			if (sub === "quiet" || sub === "eyes-free" || sub === "normal") return setSwitch(c, sub);
			if (sub === "status") {
				const cfg = loadVoiceConfig();
				const creds = await host.credentials().catch(() => undefined);
				return c.ui.notify(
					`Voice mode ${active ? "on" : "off"} · ${switchOf(cfg)} · ${cfg.realtimeModel || DEFAULT_REALTIME_MODEL} via ${creds ? (creds.kind === "chatgpt" ? "ChatGPT sign-in" : "OPENAI_API_KEY") : "no credentials"} · turns ${cfg.turnDetection === "semantic" ? "semantic" : "server VAD"} · mic ${process.env.PI_SPEECH_MIC ?? "default"} · player ${process.env.PI_SPEECH_PLAYER ?? "default output"}`,
					"info",
				);
			}
			c.ui.notify(`Usage: /voice [quiet|eyes-free|normal|status]  (${voiceShortcut()} starts and stops voice mode)`, "info");
		},
	});
}
