// Terminal voice mode's audio in and out, as raw PCM through ffmpeg: the microphone at 48 kHz (mic.ts),
// and a player that writes the model's voice and the earcons to the default output (macOS
// AudioToolbox; elsewhere ffplay). Headphones assumed: there is no echo cancellation.
//
//   PI_SPEECH_PLAYER=file:<path.wav>   record what would be played, on a wall-clock timeline (tests, demos)
//   PI_SPEECH_PLAYER=none              play nothing
//
// Tests and end-to-end runs use the file player, so they never play through the user's speakers.

import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Mic, micDevice, startMic } from "./mic.ts";
import { findFfmpeg } from "./stt.ts";

export const AUDIO_RATE = 48000;

export interface Player {
	/** Queues mono s16le PCM at 48 kHz. */
	write(pcm: Buffer): void;
	/** Drops everything still buffered at once (barge-in). */
	flush(): void;
	close(): void;
	readonly target: string;
}

export type PlayerTarget = { kind: "device" } | { kind: "file"; path: string } | { kind: "none" };

export function playerTarget(env = process.env): PlayerTarget {
	const v = env.PI_SPEECH_PLAYER?.trim();
	if (v?.startsWith("file:")) return { kind: "file", path: v.slice(5) };
	if (v === "none" || v === "off") return { kind: "none" };
	return { kind: "device" };
}

export async function openPlayer(target = playerTarget(), now: () => number = Date.now): Promise<Player> {
	if (target.kind === "file") return new FilePlayer(target.path, now);
	if (target.kind === "none") return { write() {}, flush() {}, close() {}, target: "none" };
	const ff = await findFfmpeg();
	if (!ff) throw new Error("voice mode needs ffmpeg to play audio (brew install ffmpeg / apt install ffmpeg)");
	return new DevicePlayer(playerCommand(ff));
}

/** The process that plays raw PCM on the default output. */
export function playerCommand(ff: string, platform = process.platform): { cmd: string; args: string[] } {
	const input = ["-fflags", "nobuffer", "-probesize", "32", "-analyzeduration", "0", "-f", "s16le", "-ar", String(AUDIO_RATE)];
	if (platform === "darwin") return { cmd: ff, args: ["-hide_banner", "-loglevel", "error", "-nostats", ...input, "-ac", "1", "-i", "pipe:0", "-f", "audiotoolbox", "-"] };
	// ffmpeg has no Windows audio output; ffplay plays everywhere.
	const ffplay = ff.includes("/") || ff.includes("\\") ? join(dirname(ff), platform === "win32" ? "ffplay.exe" : "ffplay") : "ffplay";
	return { cmd: ffplay, args: ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", ...input, "-ch_layout", "mono", "-i", "pipe:0"] };
}

/**
 * Plays through a child process. Barge-in kills it (SIGKILL drops what the audio queue holds at once)
 * and promotes a spare that was started in advance, so the next sentence starts without a delay.
 */
class DevicePlayer implements Player {
	private cur?: ChildProcess;
	private spare?: ChildProcess;
	private closed = false;
	private wrote = false;
	readonly target = "device";
	private command: { cmd: string; args: string[] };

	constructor(command: { cmd: string; args: string[] }) {
		this.command = command;
		this.cur = this.spawn();
		this.spare = this.spawn();
	}

	private spawn(): ChildProcess {
		const child = spawn(this.command.cmd, this.command.args, { stdio: ["pipe", "ignore", "ignore"] });
		child.stdin!.on("error", () => {});
		child.on("error", () => {});
		return child;
	}

	write(pcm: Buffer): void {
		if (this.closed) return;
		if (!this.cur || this.cur.exitCode !== null || this.cur.killed) {
			this.cur = this.takeSpare();
		}
		this.wrote = true;
		this.cur.stdin!.write(pcm);
	}

	flush(): void {
		if (this.closed || !this.wrote) return;
		this.wrote = false;
		this.cur?.kill("SIGKILL");
		this.cur = this.takeSpare();
	}

	/** The spare, promoted (a live one, else a new process); a new spare takes its place. */
	private takeSpare(): ChildProcess {
		const s = this.spare;
		this.spare = this.spawn();
		return s && s.exitCode === null && !s.killed ? s : this.spawn();
	}

	close(): void {
		this.closed = true;
		this.cur?.kill("SIGKILL");
		this.spare?.kill("SIGKILL");
	}
}

/**
 * Records instead of playing: what would be heard, when it would be heard. Gaps between writes become
 * silence; a flush cuts the audio that would not have been played yet, as killing the player does.
 */
export class FilePlayer implements Player {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private start: number;
	private end = 0; // ms after start where the queued audio ends
	private saveTimer?: NodeJS.Timeout;
	readonly target: string;
	private path: string;
	private now: () => number;

	constructor(path: string, now: () => number = Date.now) {
		this.path = path;
		this.now = now;
		this.start = now();
		this.target = `file:${path}`;
	}

	write(pcm: Buffer): void {
		const t = this.now() - this.start;
		if (t > this.end) this.append(Buffer.alloc(msToBytes(Math.min(t - this.end, 60_000))));
		this.end = Math.max(this.end, t);
		this.append(pcm);
		this.end += (pcm.length / 2 / AUDIO_RATE) * 1000;
		this.saveSoon();
	}

	flush(): void {
		const t = this.now() - this.start;
		if (this.end <= t) return;
		const cut = Math.min(this.bytes, msToBytes(this.end - t));
		const all = Buffer.concat(this.chunks).subarray(0, this.bytes - cut);
		this.chunks = [all];
		this.bytes = all.length;
		this.end = t;
		this.saveSoon();
	}

	close(): void {
		clearTimeout(this.saveTimer);
		this.save();
	}

	/** Everything recorded so far (mono s16le, 48 kHz). */
	pcm(): Buffer {
		return Buffer.concat(this.chunks);
	}

	private append(b: Buffer): void {
		this.chunks.push(b);
		this.bytes += b.length;
	}

	private saveSoon(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.save();
		}, 1000);
		this.saveTimer.unref?.();
	}

	private save(): void {
		try {
			writeFileSync(this.path, wav(this.pcm(), AUDIO_RATE));
		} catch {}
	}
}

function msToBytes(ms: number): number {
	return Math.round((ms * AUDIO_RATE) / 1000) * 2;
}

/** Mono s16le PCM as a WAV file. */
export function wav(pcm: Buffer, rate: number): Buffer {
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

export interface Capture {
	stop(): void;
}

/**
 * The microphone at 48 kHz. A `file:` microphone (PI_SPEECH_MIC) is followed by silence when the
 * recording ends, as a real room would be: the server only ends a turn on silence.
 */
export async function startCapture(onPcm: (pcm: Buffer) => void, onError: (message: string) => void): Promise<Capture> {
	let silence: NodeJS.Timeout | undefined;
	const feedSilence = () => {
		const frame = Buffer.alloc((AUDIO_RATE / 50) * 2);
		let next = Date.now();
		silence = setInterval(() => {
			while (next <= Date.now()) {
				onPcm(frame);
				next += 20;
			}
		}, 20);
	};
	const mic: Mic = await startMic(onPcm, onError, { rate: AUDIO_RATE, onEnd: micDevice()?.startsWith("file:") ? feedSilence : undefined });
	return {
		stop() {
			clearInterval(silence);
			mic.stop();
		},
	};
}
