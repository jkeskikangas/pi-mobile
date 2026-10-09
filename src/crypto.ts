// End-to-end envelope shared with web/app.js: NaCl secretbox (XSalsa20-Poly1305), base64url(nonce || box).
// The transport (plain LAN HTTP, a tunnel, a relay) never sees plaintext or a reusable credential.

import nacl from "tweetnacl";

export const KEY_BYTES = nacl.secretbox.keyLength;

export function b64u(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function unb64u(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "base64url"));
}

export function randomKey(): Uint8Array {
	return nacl.randomBytes(KEY_BYTES);
}

export function randomId(bytes = 9): string {
	return b64u(nacl.randomBytes(bytes));
}

export function seal(key: Uint8Array, value: unknown): string {
	const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
	const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(value)), nonce, key);
	const out = new Uint8Array(nonce.length + box.length);
	out.set(nonce);
	out.set(box, nonce.length);
	return b64u(out);
}

/** Returns the decrypted value and its nonce (for replay checks), or undefined when forged or garbled. */
export function open<T = unknown>(key: Uint8Array, sealed: string): { value: T; nonce: string } | undefined {
	try {
		const raw = unb64u(sealed);
		const n = nacl.secretbox.nonceLength;
		if (raw.length <= n + nacl.secretbox.overheadLength) return undefined;
		const plain = nacl.secretbox.open(raw.subarray(n), raw.subarray(0, n), key);
		if (!plain) return undefined;
		return { value: JSON.parse(new TextDecoder().decode(plain)) as T, nonce: b64u(raw.subarray(0, n)) };
	} catch {
		return undefined;
	}
}

/**
 * Rejects stale or replayed requests. Each sealed request carries a client timestamp `t`;
 * nonces are remembered for the whole acceptance window, so a captured request cannot be resent.
 */
export class ReplayGuard {
	private seen = new Map<string, number>();
	private readonly windowMs: number;

	constructor(windowMs = 10 * 60_000) {
		this.windowMs = windowMs;
	}

	accept(nonce: string, t: unknown, now = Date.now()): boolean {
		if (typeof t !== "number" || Math.abs(now - t) > this.windowMs) return false;
		if (this.seen.has(nonce)) return false;
		if (this.seen.size > 5000) this.prune(now);
		this.seen.set(nonce, now);
		return true;
	}

	private prune(now: number): void {
		for (const [n, at] of this.seen) if (now - at > this.windowMs * 2) this.seen.delete(n);
	}
}
