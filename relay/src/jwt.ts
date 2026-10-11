// Compact JWS signing with WebCrypto: ES256 for APNs provider tokens, RS256 for Google OAuth assertions.

import { b64u, b64uJson, pemBody, utf8 } from "./b64.ts";

export function importEs256(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", pemBody(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export function importRs256(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", pemBody(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** WebCrypto ECDSA already returns IEEE P1363 (r||s), which is what JWS ES256 wants. */
export async function signJwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
	const unsigned = `${b64uJson(header)}.${b64uJson(claims)}`;
	const algo = key.algorithm.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
	const sig = await crypto.subtle.sign(algo, key, utf8(unsigned));
	return `${unsigned}.${b64u(sig)}`;
}
