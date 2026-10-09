// Voice requests served inside each pi process (through the bridge): transcription and intent
// distillation, spoken briefs and details for voice mode, the realtime call setup, and the voice
// note that tells the agent its user is listening rather than reading.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type VoiceConfig, writePrivate } from "../store.ts";
import { Dictionary } from "./dictionary.ts";
import { distill, editorText } from "./distill.ts";
import type { Complete } from "./model.ts";
import { createCall, chatgptAccountId, DEFAULT_REALTIME_MODEL, type RealtimeCredentials, realtimeSession } from "./realtime.ts";
import { type Attention, brief, countWord, digestText, runDigest, speakable } from "./speech.ts";
import { chooseStt, type SttProvider } from "./stt.ts";
import { synthesize, ttsTarget } from "./tts.ts";
import { gatherVocabulary, recognizerHints, sayName } from "./vocab.ts";

const MAX_AUDIO = 20 * 1024 * 1024;

export interface VoiceHostDeps {
	ctx: () => ExtensionContext;
	config: () => VoiceConfig | undefined;
	stateDir: () => string;
	complete: Complete;
	/** Replaceable in tests. */
	stt?: () => SttProvider;
	credentials?: () => Promise<RealtimeCredentials | undefined>;
	fetch?: typeof fetch;
}

export const DETAILS_SYSTEM = (mode: Attention) => `You answer a developer's spoken question about what their coding agent just did, for listening, from the report below only. ${
	mode === "eyes-busy" ? "They cannot look at a screen." : ""
} Answer at the level of behaviour, design and decisions: what changed for the system or its users, why, what is left, risks. No identifiers, file names, commands, code, symbols, markdown or URLs unless the question asks for them; then say names the way a person does. At most 4 short sentences, plain spoken language, numbers rounded. Lists of more than three things: give the count and the three most important. If the report does not answer the question, say so in one sentence.`;

export class VoiceHost {
	private deps: VoiceHostDeps;
	/** Set while a phone follows this session in voice mode; the phone refreshes it every minute. */
	private listening?: { mode: Attention; seen: number };

	/** The attention mode of the phone listening by voice, if one has checked in recently. */
	listeningMode(now = Date.now()): Attention | undefined {
		return this.listening && now - this.listening.seen < 150_000 ? this.listening.mode : undefined;
	}

	constructor(deps: VoiceHostDeps) {
		this.deps = deps;
	}

	private branch(): any[] {
		try {
			return this.deps.ctx().sessionManager.getBranch() as any[];
		} catch {
			return [];
		}
	}

	async vocabulary() {
		return gatherVocabulary(this.deps.ctx().cwd, this.branch(), this.dictionary().top());
	}

	async hints(): Promise<string[]> {
		return recognizerHints(await this.vocabulary());
	}

	stt(): SttProvider {
		return this.deps.stt?.() ?? chooseStt(this.deps.config(), this.deps.stateDir());
	}

	/** Speech → text on this computer, then (optionally) intent distillation. */
	async transcribe(p: { audio?: unknown; mime?: unknown; distill?: unknown; draft?: unknown }) {
		if (typeof p.audio !== "string" || !p.audio) throw new Error("no audio");
		const audio = Buffer.from(p.audio, "base64");
		if (audio.length > MAX_AUDIO) throw new Error("recording too long");
		const v = await this.vocabulary();
		const t = await this.stt().transcribe(audio, String(p.mime ?? "audio/webm"), recognizerHints(v));
		if (p.distill === false) return { raw: t.text, text: t.text, unclear: [], provider: t.provider, by: "none" };
		const d = await distill(t.text, v, this.branch(), this.deps.complete, { draft: typeof p.draft === "string" ? p.draft : "" });
		return { raw: t.text, text: d.text, editor: editorText(d), unclear: d.unclear, provider: t.provider, by: d.by, error: d.error };
	}

	async distill(p: { raw?: unknown; draft?: unknown }) {
		const raw = String(p.raw ?? "");
		const d = await distill(raw, await this.vocabulary(), this.branch(), this.deps.complete, { draft: typeof p.draft === "string" ? p.draft : "" });
		return { raw, text: d.text, editor: editorText(d), unclear: d.unclear, by: d.by, error: d.error };
	}

	/** The spoken brief of the latest run, plus the report the voice layer answers follow-ups from. */
	async brief(p: { mode?: unknown }) {
		const mode = attention(p.mode);
		const d = runDigest(this.branch());
		const b = await brief(d, mode, this.deps.complete);
		return { speech: b.speech, more: b.more, by: b.by, report: digestText(d).slice(0, 8000) };
	}

	/** On-demand detail, verbalised for the ear. Common topics are answered without a model. */
	async details(p: { topic?: unknown; mode?: unknown }) {
		const topic = String(p.topic ?? "").toLowerCase();
		const d = runDigest(this.branch());
		// File names only when asked for by name; "what changed" is answered at the level of behaviour below.
		if (/\b(which|what|name|list)\b.*\bfiles?\b|\bfiles?\b.*\b(changed|touched|edited)\b/.test(topic)) {
			if (!d.edits.length) return { speech: "No files changed in the last run." };
			const list = d.edits.slice(0, 3).map((e) => `${sayName(e.path)}, ${lines(e.added, "added")}${e.removed ? ` and ${lines(e.removed, "removed")}` : ""}`);
			const extra = d.edits.length > 3 ? ` And ${countWord(d.edits.length - 3, "more file")}.` : "";
			return { speech: `${countWord(d.edits.length, "file")} changed: ${list.join("; ")}.${extra}` };
		}
		if (/\b(fail|failed|failing|errors?|broke|broken)\b/.test(topic)) {
			const failed = d.commands.filter((c) => !c.ok);
			if (!failed.length && !d.errors.length) return { speech: "Nothing failed in the last run." };
		}
		if (/\b(full|whole|everything|entire|read (it|the reply))\b/.test(topic)) return { speech: speakable(d.final) || "There was no written reply." };
		const mode = attention(p.mode);
		try {
			const out = await this.deps.complete(DETAILS_SYSTEM(mode), `QUESTION: ${topic}\n\nREPORT:\n${digestText(d)}`, { maxTokens: 400 });
			return { speech: speakable(out) };
		} catch {
			return { speech: speakable(d.final).slice(0, 600) || "I don't have more detail on that." };
		}
	}

	async credentials(): Promise<RealtimeCredentials | undefined> {
		if (this.deps.credentials) return this.deps.credentials();
		if (process.env.OPENAI_API_KEY) return { kind: "api-key", token: process.env.OPENAI_API_KEY };
		const token = await (this.deps.ctx().modelRegistry as any).getApiKeyForProvider?.("openai-codex").catch(() => undefined);
		return token ? { kind: "chatgpt", token, accountId: chatgptAccountId(token) } : undefined;
	}

	/** Sets up the phone's realtime call. Throws `realtime unavailable` so the phone falls back to the cascade. */
	async voiceSession(p: { sdp?: unknown; mode?: unknown }) {
		const cfg = this.deps.config();
		if (cfg?.realtime === "off") throw new Error("realtime unavailable: turned off in the voice config");
		if (typeof p.sdp !== "string" || !p.sdp.startsWith("v=")) throw new Error("bad offer");
		const creds = await this.credentials();
		if (!creds) throw new Error("realtime unavailable: sign in to ChatGPT in pi (/login openai-codex) or set OPENAI_API_KEY");
		const mode = attention(p.mode);
		const model = cfg?.realtimeModel || DEFAULT_REALTIME_MODEL;
		const session = realtimeSession({
			mode,
			project: this.deps.ctx().cwd.split("/").pop() || "project",
			model,
			voice: cfg?.realtimeVoice,
			hints: (await this.hints()).slice(0, 60),
			language: cfg?.locale,
			turnDetection: cfg?.turnDetection,
		});
		const call = await createCall(creds, p.sdp, session, this.deps.fetch);
		return { sdp: call.sdp, model, provider: creds.kind };
	}

	/** Speech audio for basic voice mode; throws `tts unavailable` when the phone should speak itself. */
	speak(p: { text?: unknown }) {
		return synthesize(String(p.text ?? ""), ttsTarget(this.deps.config()), this.deps.fetch);
	}

	dictionary(): Dictionary {
		return new Dictionary(this.deps.stateDir(), writePrivate);
	}

	/** Learns from how the developer edited a distilled dictation before sending it. */
	learn(p: { distilled?: unknown; sent?: unknown }) {
		if (typeof p.distilled !== "string" || typeof p.sent !== "string") throw new Error("distilled and sent text expected");
		return { learned: this.dictionary().learn(p.distilled.slice(0, 8000), p.sent.slice(0, 8000)) };
	}

	setListening(p: { on?: unknown; mode?: unknown }) {
		this.listening = p.on ? { mode: attention(p.mode), seen: Date.now() } : undefined;
		return { ok: true };
	}
}

function attention(v: unknown): Attention {
	return v === "glance" ? "glance" : "eyes-busy";
}

function lines(n: number, what: string): string {
	return n >= 20 ? `about ${Math.round(n / 10) * 10} lines ${what}` : `${countWord(n, "line")} ${what}`;
}
