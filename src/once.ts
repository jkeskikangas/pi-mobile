// At-most-once phone actions (issue #1). The phone sends an idempotency key with each action and reuses it
// when it repeats an action whose reply it lost; pi runs the action once and answers every repeat with the
// first outcome. Lives in the pi session's own process, so it survives the hub moving to another pi.

export const ONCE_TTL_MS = 15 * 60_000;
const MAX = 2000;

export class Once {
	private seen = new Map<string, { at: number; result: Promise<unknown> }>();
	private readonly ttlMs: number;

	constructor(ttlMs = ONCE_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	/** Runs `fn` the first time `key` is seen within the TTL; later calls get the same result or error. */
	run<T>(key: string, fn: () => Promise<T> | T, now = Date.now()): Promise<T> {
		const hit = this.seen.get(key);
		if (hit && now - hit.at < this.ttlMs) return hit.result as Promise<T>;
		if (this.seen.size >= MAX) for (const [k, v] of this.seen) if (now - v.at >= this.ttlMs || this.seen.size >= MAX) this.seen.delete(k);
		const result = Promise.resolve().then(fn);
		result.catch(() => {});
		this.seen.set(key, { at: now, result });
		return result;
	}
}

/** A key from the phone: short opaque text, or undefined. */
export function actionKey(k: unknown): string | undefined {
	return typeof k === "string" && /^[\w-]{8,64}$/.test(k) ? k : undefined;
}
