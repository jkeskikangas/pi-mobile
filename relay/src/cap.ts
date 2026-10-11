// Stateless capabilities: the relay keeps no database. A cap is the device token sealed with the
// relay's own AES-256-GCM key, so only this relay can open it and hubs never see the raw token.

import { b64u, unb64, utf8 } from "./b64.ts";

export type Platform = "apns" | "fcm";

export interface Device {
	p: Platform;
	/** Device token (APNs hex) or FCM registration token. */
	t: string;
	/** APNs sandbox (development build). */
	s: boolean;
}

interface CapBody extends Device {
	v: 1;
	iat: number;
	/** Random id: two registrations of the same token give different caps. */
	rid: string;
}

export async function importCapKey(b64: string): Promise<CryptoKey> {
	const raw = unb64(b64);
	if (raw.length !== 32) throw new Error("CAP_KEY must be 32 bytes, base64");
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `base64url(iv(12) || AES-GCM ciphertext+tag)`. */
export async function sealCap(key: CryptoKey, d: Device, now = Date.now()): Promise<string> {
	const body: CapBody = { v: 1, p: d.p, t: d.t, s: d.s, iat: Math.floor(now / 1000), rid: b64u(crypto.getRandomValues(new Uint8Array(9))) };
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(JSON.stringify(body))));
	const out = new Uint8Array(12 + ct.length);
	out.set(iv);
	out.set(ct, 12);
	return b64u(out);
}

/** The device, or undefined when the cap is malformed, tampered with or sealed under another key. */
export async function openCap(key: CryptoKey, cap: string): Promise<Device | undefined> {
	try {
		if (typeof cap !== "string" || cap.length > 2048) return undefined;
		const raw = unb64(cap);
		if (raw.length < 12 + 16) return undefined;
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
		const b = JSON.parse(new TextDecoder().decode(pt)) as CapBody;
		if (b.v !== 1 || (b.p !== "apns" && b.p !== "fcm") || typeof b.t !== "string") return undefined;
		return { p: b.p, t: b.t, s: !!b.s };
	} catch {
		return undefined;
	}
}

export function validToken(p: Platform, t: unknown): t is string {
	if (typeof t !== "string") return false;
	return p === "apns" ? /^[0-9a-fA-F]{32,200}$/.test(t) : /^[\w:.-]{20,4096}$/.test(t);
}
