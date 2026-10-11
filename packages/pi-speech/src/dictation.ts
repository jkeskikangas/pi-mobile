// Voice input in the terminal: speak instead of typing, review the distilled prompt in the editor.
//
//   alt+m or /dictate      start listening; again (or Enter) to finish; Esc cancels
//   /dictate raw           put the verbatim transcript of the last dictation in the editor
//   /dictate undo          restore the editor to what it was before the last dictation
//   /dictate send|review   after dictation, send right away or leave it in the editor (default)
//   /dictate status        recogniser, model and microphone in use

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVoiceConfig, saveVoiceConfig, speechDir, writePrivate } from "./config.ts";
import { Dictionary } from "./dictionary.ts";
import { distill, editorText } from "./distill.ts";
import { inputDeviceName, level, MIC_RATE, type Mic, SILENT_PEAK, silenceAdvice, startMic } from "./mic.ts";
import { type Complete, registryComplete } from "./model.ts";
import { chooseStt, type LiveTranscription, prewarmApple } from "./stt.ts";
import { gatherVocabulary, recognizerHints } from "./vocab.ts";

const WIDGET = "pi-speech-dictation";
// pi-mobile registers dictation itself and also bundles pi-speech: whichever loads first owns it.
const CLAIM = Symbol.for("pi-speech.dictation");
const MAX_MS = 5 * 60_000;
const SILENCE_STOP_MS = 30_000;
const BARS = " ▁▂▃▄▅▆▇█";

interface Last {
	raw: string;
	distilled: string;
	before: string;
	learned?: boolean;
}

export function registerDictation(pi: ExtensionAPI, complete?: Complete): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[CLAIM]) return;
	const claim = {};
	g[CLAIM] = claim;
	let ctx: ExtensionContext | undefined;
	let rec: Recording | undefined;
	let last: Last | undefined;
	let clearTimer: NodeJS.Timeout | undefined;
	const done = complete ?? registryComplete(() => ctx!, () => loadVoiceConfig().model);

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		// Only in a real interactive terminal (not tests, print or RPC modes).
		const cfg = loadVoiceConfig();
		if (c.mode === "tui" && process.stdout.isTTY && (cfg.stt ?? "auto") !== "openai") prewarmApple(speechDir(), cfg.locale);
	});
	pi.on("session_shutdown", async () => {
		rec?.cancel("");
		// A reload loads both extensions again; let the next runtime claim dictation.
		if (g[CLAIM] === claim) delete g[CLAIM];
	});
	pi.on("input", async (e: any) => {
		if (!rec && ctx?.hasUI) ctx.ui.setWidget(WIDGET, undefined);
		// What you changed in a dictation before sending it is learned for next time.
		if (last && !last.learned && typeof e?.text === "string" && e.source !== "extension") {
			last.learned = true;
			try {
				new Dictionary(speechDir(), writePrivate).learn(last.distilled, e.text);
			} catch {}
		}
		return { action: "continue" as const };
	});

	const toggle = async (c: ExtensionContext) => {
		ctx = c;
		if (c.mode !== "tui") return c.ui.notify("Voice input needs the interactive terminal.", "warning");
		if (rec) return rec.finish();
		clearTimeout(clearTimer);
		rec = new Recording(
			c,
			done,
			(r) => {
				if (rec === r) rec = undefined;
			},
			(text, idle) => (idle ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "steer" })),
		);
		rec.onResult = (l) => {
			last = l;
			clearTimer = setTimeout(() => c.ui.setWidget(WIDGET, undefined), 20_000);
		};
		await rec.start();
	};

	pi.registerShortcut("alt+m", { description: "Voice input: start or finish dictation", handler: toggle });

	pi.registerCommand("dictate", {
		description: "Voice input: dictate, get a clean prompt to review (alt+m). raw | undo | send | review | status",
		getArgumentCompletions: (prefix) =>
			["raw", "undo", "send", "review", "status"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().toLowerCase();
			if (!sub) return toggle(c);
			if (sub === "raw" || sub === "undo") {
				if (!last) return c.ui.notify("No dictation yet. Press alt+m to start.", "info");
				c.ui.setEditorText(sub === "raw" ? (last.before ? `${last.before} ${last.raw}` : last.raw) : last.before);
				return;
			}
			if (sub === "send" || sub === "review") {
				saveVoiceConfig({ ...loadVoiceConfig(), afterDictation: sub });
				return c.ui.notify(sub === "send" ? "Dictation is sent as soon as it is distilled." : "Dictation goes to the editor for review.", "info");
			}
			if (sub === "status") {
				const cfg = loadVoiceConfig();
				let stt = "";
				try {
					stt = chooseStt(cfg, speechDir()).name;
				} catch (e: any) {
					stt = `unavailable (${e.message})`;
				}
				const mic = await inputDeviceName();
				return c.ui.notify(
					`Voice input: recogniser ${stt}${cfg?.locale ? ` (${cfg.locale})` : ""} · model ${cfg?.model ?? "auto (fast model you have)"} · after dictation: ${cfg?.afterDictation ?? "review"} · mic ${mic ? `${mic}${process.env.PI_SPEECH_MIC || process.env.PI_MOBILE_MIC ? "" : " (system default)"}` : "system default"}`,
					"info",
				);
			}
			c.ui.notify("Usage: /dictate [raw|undo|send|review|status]  (alt+m starts and finishes dictation)", "info");
		},
	});
}

class Recording {
	private c: ExtensionContext;
	private complete: Complete;
	private onEnd: (r: Recording) => void;
	private mic?: Mic;
	private live?: LiveTranscription;
	private partial = "";
	private levels: number[] = [];
	private peak = 0;
	private lastVoice = Date.now();
	private startedAt = Date.now();
	private timer?: NodeJS.Timeout;
	private unsubscribe?: () => void;
	private state: "starting" | "listening" | "thinking" | "done" = "starting";
	private before = "";
	private abort = new AbortController();
	onResult: (l: Last) => void = () => {};

	private send: (text: string, idle: boolean) => void;

	constructor(c: ExtensionContext, complete: Complete, onEnd: (r: Recording) => void, send: (text: string, idle: boolean) => void) {
		this.c = c;
		this.send = send;
		this.complete = complete;
		this.onEnd = onEnd;
	}

	async start(): Promise<void> {
		this.before = this.c.ui.getEditorText();
		this.render();
		// Keys while listening: Enter or alt+m finishes, Esc cancels; everything else is swallowed so a
		// stray key doesn't edit the draft underneath.
		this.unsubscribe = this.c.ui.onTerminalInput((data) => {
			if (this.state === "done") return undefined;
			if (data === "\x1b" || data === "\x03") {
				this.cancel("Dictation cancelled.");
				return { consume: true };
			}
			if (this.state === "thinking") return { consume: true };
			if (data === "\r" || data === "\n" || data === "\x1bm" || data === "µ") void this.finish();
			return { consume: true };
		});
		try {
			const cfg = loadVoiceConfig();
			const stt = chooseStt(cfg, speechDir());
			const vocab = await gatherVocabulary(this.c.cwd, this.c.sessionManager.getBranch() as any[], new Dictionary(speechDir(), writePrivate).top());
			this.live = stt.live!(MIC_RATE, recognizerHints(vocab));
			this.live.onPartial = (t) => {
				this.partial = t;
			};
			this.mic = await startMic(
				(pcm) => {
					this.live?.write(pcm);
					const l = level(pcm);
					if (l > this.peak) this.peak = l;
					this.levels.push(l);
					if (this.levels.length > 24) this.levels.shift();
					if (l > 0.04) this.lastVoice = Date.now();
				},
				(msg) => this.cancel(msg, "error"),
			);
			this.startedAt = Date.now();
			this.lastVoice = Date.now();
			this.state = "listening";
			this.timer = setInterval(() => {
				const now = Date.now();
				if (now - this.startedAt > MAX_MS || now - this.lastVoice > SILENCE_STOP_MS) void this.finish();
				this.render();
			}, 100);
		} catch (e: any) {
			this.cancel(`Voice input: ${e?.message ?? e}`, "error");
		}
	}

	async finish(): Promise<void> {
		if (this.state !== "listening") return;
		this.state = "thinking";
		this.mic?.stop();
		clearInterval(this.timer);
		this.render();
		try {
			const t = await this.live!.end();
			const raw = t.text.trim();
			if (!raw) {
				if (this.peak < SILENT_PEAK) return this.cancel(silenceAdvice(await inputDeviceName()), "warning");
				return this.cancel("Heard sound but no words. Speak a little closer, or check /dictate status for the microphone and recogniser.", "warning");
			}
			this.partial = raw;
			this.render();
			const vocab = await gatherVocabulary(this.c.cwd, this.c.sessionManager.getBranch() as any[], new Dictionary(speechDir(), writePrivate).top());
			const d = await distill(raw, vocab, this.c.sessionManager.getBranch() as any[], this.complete, {
				draft: this.before,
				signal: this.abort.signal,
			});
			if (this.state !== "thinking") return;
			const text = d.by === "model" ? editorText(d) : this.before ? `${this.before} ${editorText(d)}` : editorText(d);
			this.state = "done";
			this.cleanup();
			const send = loadVoiceConfig().afterDictation === "send" && !d.unclear.length;
			const words = raw.split(/\s+/).length;
			const secs = Math.round((Date.now() - this.startedAt) / 1000);
			const t2 = this.c.ui.theme;
			this.onResult({ raw, distilled: text, before: this.before });
			if (send) {
				this.c.ui.setEditorText("");
				this.send(text, this.c.isIdle());
			} else this.c.ui.setEditorText(text);
			const how = d.by === "model" ? "distilled" : `cleaned up locally${d.error ? ` (model unavailable: ${d.error.slice(0, 80)})` : ""}`;
			this.c.ui.setWidget(WIDGET, [
				t2.fg("dim", `Dictated ${secs}s, ${words} words → ${how}${send ? " and sent" : ""}${d.unclear.length ? ` · ${d.unclear.length} unclear point${d.unclear.length > 1 ? "s" : ""} noted` : ""} · /dictate raw for the transcript · /dictate undo restores`),
			]);
		} catch (e: any) {
			if (this.state === "thinking") this.cancel(`Voice input: ${e?.message ?? e}`, "error");
		}
	}

	cancel(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.state === "done") return;
		this.state = "done";
		this.abort.abort();
		this.mic?.stop();
		this.live?.cancel();
		this.cleanup();
		this.c.ui.setWidget(WIDGET, undefined);
		if (message) this.c.ui.notify(message, level);
	}

	private cleanup(): void {
		clearInterval(this.timer);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.onEnd(this);
	}

	private render(): void {
		if (!this.c.hasUI) return;
		const t = this.c.ui.theme;
		const secs = Math.floor((Date.now() - this.startedAt) / 1000);
		const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
		const meter = this.levels.map((l) => BARS[Math.min(BARS.length - 1, Math.round(Math.sqrt(l) * (BARS.length - 1)))]).join("");
		const head =
			this.state === "starting"
				? `${t.fg("dim", "○")} ${t.fg("dim", "Starting the microphone…  Esc cancels")}`
				: this.state === "listening"
					? `${t.fg("error", "●")} ${t.bold("Listening")} ${t.fg("dim", clock)} ${t.fg("accent", meter)}  ${t.fg("dim", "Enter/alt+m finish · Esc cancel")}`
					: `${t.fg("accent", "◌")} ${t.bold("Distilling")} ${t.fg("dim", "what you meant…  Esc cancels")}`;
		const text = this.partial ? wrap(this.partial, 6).map((l) => t.fg("dim", l)) : [];
		this.c.ui.setWidget(WIDGET, [head, ...text]);
	}
}

/** The tail of the live transcript, wrapped to at most `maxLines` lines of the terminal width. */
function wrap(text: string, maxLines: number): string[] {
	const width = Math.max(20, (process.stdout.columns || 100) - 4);
	const lines: string[] = [];
	let cur = "";
	for (const w of text.split(/\s+/)) {
		if ((cur ? cur.length + 1 : 0) + w.length > width) {
			lines.push(cur);
			cur = w;
		} else cur = cur ? `${cur} ${w}` : w;
	}
	if (cur) lines.push(cur);
	return lines.length > maxLines ? ["…", ...lines.slice(-maxLines + 1)] : lines;
}
