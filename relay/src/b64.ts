// base64 / base64url helpers over Web APIs only (Workers and Node both have btoa/atob).

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
	const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]!);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64 or base64url; throws on garbage. */
export function unb64(s: string): Uint8Array<ArrayBuffer> {
	const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
export const b64uJson = (o: unknown): string => b64u(utf8(JSON.stringify(o)));

/** DER bytes from a PEM block (PKCS#8 `-----BEGIN PRIVATE KEY-----`). */
export function pemBody(pem: string): Uint8Array<ArrayBuffer> {
	const m = /-----BEGIN [A-Z ]+-----([\s\S]+?)-----END [A-Z ]+-----/.exec(pem);
	if (!m) throw new Error("not a PEM key");
	return unb64(m[1]!);
}

export async function sha256Hex(s: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)));
	return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
