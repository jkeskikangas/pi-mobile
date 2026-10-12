// The typing gate (designs/voice-modalities.md, "Only timing adapts, never the channel"): speech waits
// until the developer stops typing, about 1.5 s without a key. Questions and failures play their
// sound at once and are spoken at the next pause; the working tick never plays while typing.

export const TYPING_PAUSE_MS = 1500;

export class TypingGate {
	private last = Number.NEGATIVE_INFINITY;
	private pauseMs: number;
	private now: () => number;

	constructor(pauseMs = TYPING_PAUSE_MS, now: () => number = Date.now) {
		this.pauseMs = pauseMs;
		this.now = now;
	}

	/** A key arrived. */
	key(at = this.now()): void {
		this.last = at;
	}

	/** True while keys keep arriving (less than the pause since the last one). */
	typing(at = this.now()): boolean {
		return at - this.last < this.pauseMs;
	}

	/** Milliseconds until the next pause; 0 when there is one now. */
	wait(at = this.now()): number {
		return Math.max(0, this.last + this.pauseMs - at);
	}
}
