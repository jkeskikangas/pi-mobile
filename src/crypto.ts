// End-to-end envelope shared with web/app.js: NaCl secretbox (XSalsa20-Poly1305), base64url(nonce || box).
// The transport (plain LAN HTTP, a tunnel, a relay) never sees plaintext or a reusable credential.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
	return sealWithNonce(key, nacl.randomBytes(nacl.secretbox.nonceLength), value);
}

/** `seal` with a caller-chosen nonce. Only for deterministic test vectors: never reuse a nonce in real traffic. */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, value: unknown): string {
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
	private readonly file?: string;

	/** With `file`, the seen nonces are persisted (mode 0600) and loaded by the next hub process. */
	constructor(windowMs = 10 * 60_000, file?: string) {
		this.windowMs = windowMs;
		this.file = file;
		if (file) {
			try {
				const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
				for (const [n, at] of Object.entries(saved)) if (typeof at === "number") this.seen.set(n, at);
				this.prune(Date.now());
			} catch {}
		}
	}

	accept(nonce: string, t: unknown, now = Date.now()): boolean {
		if (typeof t !== "number" || Math.abs(now - t) > this.windowMs) return false;
		if (this.seen.has(nonce)) return false;
		if (this.seen.size > 5000) this.prune(now);
		this.seen.set(nonce, now);
		this.save();
		return true;
	}

	private save(): void {
		if (!this.file) return;
		try {
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.seen)), { mode: 0o600 });
			renameSync(tmp, this.file);
		} catch {}
	}

	private prune(now: number): void {
		for (const [n, at] of this.seen) if (now - at > this.windowMs * 2) this.seen.delete(n);
	}
}
