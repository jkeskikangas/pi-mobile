// Microphone capture for the terminal through ffmpeg: 16 kHz mono s16le PCM, plus a level meter.

import { type ChildProcess, spawn } from "node:child_process";
import { findFfmpeg } from "./stt.ts";

export const MIC_RATE = 16000;

/** PI_SPEECH_MIC (or the older PI_MOBILE_MIC) picks a device, or `file:<path>` plays a recording (demos, tests). */
export function micDevice(env = process.env): string | undefined {
	return env.PI_SPEECH_MIC || env.PI_MOBILE_MIC || undefined;
}

/** ffmpeg input for the microphone. */
export function micInputArgs(platform = process.platform, device = micDevice()): string[] {
	if (device?.startsWith("file:")) return ["-re", "-i", device.slice(5)];
	if (platform === "darwin") return ["-f", "avfoundation", "-i", `:${device ?? "default"}`];
	if (platform === "win32") return ["-f", "dshow", "-i", `audio=${device ?? "default"}`];
	return ["-f", "pulse", "-i", device ?? "default"];
}

/** Peak level of an s16le chunk, 0..1. */
export function level(pcm: Buffer): number {
	let peak = 0;
	for (let i = 0; i + 1 < pcm.length; i += 2) {
		const v = Math.abs(pcm.readInt16LE(i));
		if (v > peak) peak = v;
	}
	return peak / 32768;
}

export interface Mic {
	stop(): void;
	readonly startedAt: number;
}

/** Starts capturing. `onData` gets PCM chunks; `onError` fires once if ffmpeg fails or the mic is unavailable. */
export async function startMic(onData: (pcm: Buffer) => void, onError: (message: string) => void): Promise<Mic> {
	const ff = await findFfmpeg();
	if (!ff) throw new Error("voice input needs ffmpeg for the microphone (brew install ffmpeg / apt install ffmpeg)");
	const child: ChildProcess = spawn(
		ff,
		["-hide_banner", "-loglevel", "error", "-nostdin", ...micInputArgs(), "-ac", "1", "-ar", String(MIC_RATE), "-f", "s16le", "-"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	let stopped = false;
	let got = false;
	child.stdout!.on("data", (b: Buffer) => {
		got = true;
		onData(b);
	});
	child.stderr!.on("data", (b: Buffer) => {
		stderr += b.toString();
	});
	child.on("error", (e) => onError(`microphone: ${e.message}`));
	child.on("close", (code) => {
		if (stopped) return;
		const hint =
			process.platform === "darwin" && !got
				? " (allow microphone access for your terminal in System Settings → Privacy & Security → Microphone)"
				: "";
		onError(`microphone stopped (${code}): ${stderr.trim().split("\n").pop() || "no audio"}${hint}`);
	});
	return {
		startedAt: Date.now(),
		stop() {
			stopped = true;
			child.kill("SIGINT");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref();
		},
	};
}
