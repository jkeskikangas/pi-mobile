// Earcons for terminal voice mode: short, distinct, learnable sounds for state, generated as PCM and
// played through the same player as the voice. The specs are the phone's (web/voice-core.js EARCONS),
// so a sound means the same thing on both.

export type Earcon = "listen" | "heard" | "working" | "attention" | "done" | "failed" | "off" | "draft";

/** [frequency Hz (0 = rest), duration ms, gain] steps. Mirrors web/voice-core.js. */
export const EARCONS: Record<Earcon, [number, number, number][]> = {
	listen: [[880, 70, 0.18]],
	heard: [
		[660, 60, 0.15],
		[990, 80, 0.15],
	],
	working: [[523, 45, 0.05]],
	attention: [
		[784, 110, 0.22],
		[0, 70, 0],
		[784, 110, 0.22],
	],
	done: [
		[523, 90, 0.16],
		[659, 90, 0.16],
		[784, 140, 0.16],
	],
	failed: [
		[440, 140, 0.18],
		[349, 220, 0.18],
	],
	off: [
		[660, 70, 0.14],
		[440, 110, 0.14],
	],
	// Terminal voice mode only (for now): a monologue became a draft. Soft, low and slow, so it marks
	// the change without sounding like a reply.
	draft: [
		[392, 120, 0.08],
		[523, 180, 0.08],
	],
};

const cache = new Map<string, Buffer>();

/**
 * The earcon as mono s16le PCM: sine tones with the phone's envelope (10 ms attack, linear decay to
 * the end of the step), so the terminal and the phone sound alike.
 */
export function earconPcm(name: Earcon, rate = 48000): Buffer {
	const key = `${name}@${rate}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const steps = EARCONS[name];
	const total = steps.reduce((n, [, ms]) => n + Math.round((rate * ms) / 1000), 0) + Math.round(rate * 0.02);
	const out = Buffer.alloc(total * 2);
	let at = 0;
	for (const [f, ms, g] of steps) {
		const n = Math.round((rate * ms) / 1000);
		const attack = Math.round(rate * 0.01);
		if (f)
			for (let i = 0; i < n; i++) {
				const env = i < attack ? i / attack : Math.max(0, 1 - (i - attack) / Math.max(1, n - attack));
				const v = Math.sin((2 * Math.PI * f * i) / rate) * g * env;
				out.writeInt16LE(Math.round(v * 32767), (at + i) * 2);
			}
		at += n;
	}
	cache.set(key, out);
	return out;
}
