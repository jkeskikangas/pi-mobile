// Speech recognition on the computer running pi. Two providers:
//   apple  — Apple SpeechAnalyzer through a small Swift helper, compiled once into the state dir.
//            On-device, free, streaming partials, contextual strings. macOS 26+ with Xcode tools.
//   openai — gpt-4o-transcribe with OPENAI_API_KEY (any OS), vocabulary passed as a prompt.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { VoiceConfig } from "./config.ts";

const run = promisify(execFile);
const SWIFT_SOURCE = fileURLToPath(new URL("./apple-stt.swift", import.meta.url));

export interface Transcript {
	text: string;
	provider: string;
}

export interface LiveTranscription {
	/** Feed s16le mono PCM at `rate`. */
	write(pcm: Buffer): void;
	/** Ends input; resolves with the full text. */
	end(): Promise<Transcript>;
	cancel(): void;
	onPartial: (text: string) => void;
}

export interface SttProvider {
	name: "apple" | "openai";
	/** Transcribes a complete recording (any container ffmpeg or the provider can read). */
	transcribe(audio: Buffer, mime: string, hints: string[], signal?: AbortSignal): Promise<Transcript>;
	/** Streaming recognition with partial results, when supported. */
	live?(rate: number, hints: string[]): LiveTranscription;
}

// ── audio helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

export function extFor(mime: string): string {
	if (/webm/.test(mime)) return "webm";
	if (/ogg/.test(mime)) return "ogg";
	if (/mp4|m4a|aac/.test(mime)) return "m4a";
	if (/wav/.test(mime)) return "wav";
	if (/mpeg|mp3/.test(mime)) return "mp3";
	return "bin";
}

let ffmpegPath: string | null | undefined;
export async function findFfmpeg(): Promise<string | null> {
	if (ffmpegPath !== undefined) return ffmpegPath;
	for (const p of [process.env.PI_SPEECH_FFMPEG, process.env.PI_MOBILE_FFMPEG, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
		if (!p) continue;
		try {
			await run(p, ["-version"], { timeout: 4000 });
			return (ffmpegPath = p);
		} catch {}
	}
	return (ffmpegPath = null);
}

/** Writes `audio` to a temp file, converted to 16 kHz mono WAV when ffmpeg is available. */
async function toWavFile(audio: Buffer, mime: string): Promise<{ path: string; cleanup: () => void }> {
	const dir = join(tmpdir(), `pi-speech-${randomBytes(6).toString("hex")}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	const src = join(dir, `in.${extFor(mime)}`);
	writeFileSync(src, audio);
	if (/wav/.test(mime)) return { path: src, cleanup };
	const ff = await findFfmpeg();
	if (!ff) return { path: src, cleanup };
	const out = join(dir, "in.wav");
	try {
		await run(ff, ["-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", out], { timeout: 30_000 });
		return { path: out, cleanup };
	} catch (e) {
		cleanup();
		throw new Error(`could not decode the recording: ${String((e as any)?.stderr || e).trim().slice(0, 200)}`);
	}
}

/** Peak level (0..1) of a recording in any format ffmpeg reads; undefined when it can't be decoded. */
export async function audioPeak(audio: Buffer, mime: string): Promise<number | undefined> {
	const ff = await findFfmpeg();
	if (!ff) return undefined;
	const file = await toWavFile(audio, mime).catch(() => undefined);
	if (!file) return undefined;
	try {
		const pcm = await new Promise<Buffer>((resolve, reject) =>
			execFile(ff, ["-loglevel", "error", "-i", file.path, "-ac", "1", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (e, out) =>
				e ? reject(e) : resolve(out as Buffer),
			),
		);
		let peak = 0;
		for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
		return peak / 32768;
	} catch {
		return undefined;
	} finally {
		file.cleanup();
	}
}

/** Wraps raw s16le mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcm.length, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

// ── Apple SpeechAnalyzer ────────────────────────────────────────────────────────────────────────────────────────

let appleBuild: Promise<string> | undefined;

/** Compiles the helper once per source version into `<stateDir>/bin`. */
export function appleHelper(stateDir: string): Promise<string> {
	appleBuild ??= (async () => {
		if (process.platform !== "darwin") throw new Error("Apple speech recognition needs macOS");
		const source = readFileSync(SWIFT_SOURCE);
		const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
		const dir = join(stateDir, "bin");
		const bin = join(dir, `apple-stt-${hash}`);
		if (existsSync(bin)) return bin;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = `${bin}.${process.pid}.tmp`;
		try {
			await run("xcrun", ["swiftc", "-parse-as-library", "-O", SWIFT_SOURCE, "-o", tmp], { timeout: 180_000 });
		} catch (e: any) {
			throw new Error(
				`could not build the on-device recogniser (needs macOS 26 and Xcode command line tools: xcode-select --install): ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`,
			);
		}
		renameSync(tmp, bin);
		return bin;
	})();
	appleBuild.catch(() => {
		appleBuild = undefined;
	});
	return appleBuild;
}

function parseLines(child: ChildProcess, onLine: (obj: any) => void): void {
	const rl = createInterface({ input: child.stdout! });
	rl.on("line", (line) => {
		try {
			onLine(JSON.parse(line));
		} catch {}
	});
}

let prewarmed = false;

/**
 * Builds the on-device recogniser and installs its speech model in the background, once per
 * process, so the first dictation starts instantly instead of after a compile and a download.
 */
export function prewarmApple(stateDir: string, locale?: string): void {
	if (prewarmed || process.platform !== "darwin") return;
	prewarmed = true;
	appleHelper(stateDir)
		.then((bin) => {
			const child = spawn(bin, ["check", ...(locale ? ["--locale", locale] : [])], { stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		})
		.catch(() => {});
}

export function appleProvider(stateDir: string, locale?: string): SttProvider {
	const common = (hints: string[]) => [...(hints.length ? ["--words", hints.join("\n")] : []), ...(locale ? ["--locale", locale] : [])];
	return {
		name: "apple",
		async transcribe(audio, mime, hints, signal) {
			const bin = await appleHelper(stateDir);
			const file = await toWavFile(audio, mime);
			try {
				const { stdout } = await run(bin, ["file", file.path, ...common(hints)], { timeout: 120_000, signal, maxBuffer: 8 * 1024 * 1024 });
				const out = JSON.parse(stdout.trim().split("\n").pop() || "{}");
				if (out.error) throw new Error(out.error);
				return { text: String(out.text ?? ""), provider: "apple" };
			} catch (e: any) {
				const msg = (() => {
					try {
						return JSON.parse(String(e?.stdout ?? "").trim().split("\n").pop() || "{}").error;
					} catch {
						return undefined;
					}
				})();
				throw new Error(msg || e?.message || String(e));
			} finally {
				file.cleanup();
			}
		},
		live(rate, hints) {
			let child: ChildProcess | undefined;
			let queued: Buffer[] = [];
			let ended = false;
			let cancelled = false;
			let finals = "";
			let failure: string | undefined;
			let resolveDone!: (t: Transcript) => void;
			let rejectDone!: (e: Error) => void;
			const done = new Promise<Transcript>((res, rej) => {
				resolveDone = res;
				rejectDone = rej;
			});
			done.catch(() => {});
			const live: LiveTranscription = {
				onPartial: () => {},
				write(pcm) {
					if (ended || cancelled) return;
					if (child?.stdin?.writable) child.stdin.write(pcm);
					else queued.push(pcm);
				},
				end() {
					ended = true;
					if (child) child.stdin?.end();
					return done;
				},
				cancel() {
					cancelled = true;
					child?.kill();
					rejectDone(new Error("cancelled"));
				},
			};
			// Audio is buffered while the helper starts (or compiles on first use), so nothing is lost.
			appleHelper(stateDir).then(
				(bin) => {
					if (cancelled) return;
					child = spawn(bin, ["stream", "--rate", String(rate), ...common(hints)], { stdio: ["pipe", "pipe", "ignore"] });
					child.stdin!.on("error", () => {});
					parseLines(child, (o) => {
						if (typeof o.partial === "string") live.onPartial(o.partial);
						else if (typeof o.final === "string") {
							finals = `${finals} ${o.final}`.trim();
							live.onPartial(finals);
						} else if (o.done) resolveDone({ text: String(o.text ?? finals), provider: "apple" });
						else if (o.error) failure = String(o.error);
					});
					child.on("close", (code) => {
						if (code === 0) resolveDone({ text: finals, provider: "apple" });
						else rejectDone(new Error(failure || `recogniser exited with ${code}`));
					});
					for (const b of queued) child.stdin!.write(b);
					queued = [];
					if (ended) child.stdin!.end();
				},
				(e) => rejectDone(e),
			);
			return live;
		},
	};
}

// ── OpenAI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function openaiProvider(apiKey: string, fetchImpl: typeof fetch = fetch, base = "https://api.openai.com/v1"): SttProvider {
	const provider: SttProvider = {
		name: "openai",
		async transcribe(audio, mime, hints, signal) {
			const fd = new FormData();
			fd.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/wav" }), `audio.${extFor(mime)}`);
			fd.append("model", "gpt-4o-transcribe");
			// The prompt biases recognition toward these names; it is not an instruction.
			if (hints.length) fd.append("prompt", `Software development dictation. Names: ${hints.slice(0, 80).join(", ")}`.slice(0, 2000));
			const res = await fetchImpl(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: fd, signal });
			const body: any = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(`OpenAI transcription: ${body?.error?.message ?? `HTTP ${res.status}`}`);
			const text = String(body.text ?? "");
			// On near-silent audio the transcriber can return its prompt as the transcript; that is no speech.
			return { text: /Software development dictation\. Names:/i.test(text) ? "" : text, provider: "openai" };
		},
		// No streaming over plain HTTP: collect PCM and transcribe on end.
		live(rate, hints) {
			const chunks: Buffer[] = [];
			const ctrl = new AbortController();
			return {
				onPartial: () => {},
				write: (pcm) => chunks.push(pcm),
				end: () => provider.transcribe(pcmToWav(Buffer.concat(chunks), rate), "audio/wav", hints, ctrl.signal),
				cancel: () => ctrl.abort(),
			};
		},
	};
	return provider;
}

/** The configured provider, or the first usable one: Apple on macOS, else OpenAI with a key. */
export function chooseStt(config: VoiceConfig | undefined, stateDir: string, env = process.env): SttProvider {
	const want = config?.stt ?? "auto";
	const key = env.OPENAI_API_KEY;
	if (want === "openai" || (want === "auto" && process.platform !== "darwin")) {
		if (!key) throw new Error("speech recognition needs OPENAI_API_KEY on this system (or macOS 26 for on-device recognition)");
		return openaiProvider(key);
	}
	return appleProvider(stateDir, config?.locale);
}
