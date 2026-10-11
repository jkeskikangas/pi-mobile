// APNs over fetch(). In production Workers, Cloudflare's proxy speaks HTTP/2 to Apple (see README).

import { importEs256, signJwt } from "./jwt.ts";

export const APNS_HOST = "https://api.push.apple.com";
export const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";
/** Apple's limit for ordinary remote notifications. */
export const APNS_MAX_PAYLOAD = 4096;
/** Apple accepts a provider token for an hour; refresh well before. */
const JWT_TTL_MS = 50 * 60_000;

export interface ApnsEnv {
	APNS_KEY: string;
	APNS_KEY_ID: string;
	APNS_TEAM_ID: string;
	APNS_TOPIC: string;
}

export interface PushMessage {
	sealed: string;
	urgent?: boolean;
	collapse?: string;
}

export type SendResult = { kind: "sent" } | { kind: "gone" } | { kind: "limited"; retryAfter?: string } | { kind: "failed"; status: number; reason?: string };

export function apnsPayload(m: PushMessage): unknown {
	return {
		aps: {
			alert: { title: "pi", body: "New activity" },
			"mutable-content": 1,
			sound: "default",
			"interruption-level": m.urgent ? "time-sensitive" : "active",
		},
		sealed: m.sealed,
	};
}

export function apnsHeaders(jwt: string, topic: string, m: PushMessage, now = Date.now()): Record<string, string> {
	return {
		authorization: `bearer ${jwt}`,
		"apns-topic": topic,
		"apns-push-type": "alert",
		"apns-priority": m.urgent ? "10" : "5",
		"apns-expiration": String(Math.floor(now / 1000) + 3600),
		...(m.collapse ? { "apns-collapse-id": m.collapse } : {}),
		"content-type": "application/json",
	};
}

/** Per-isolate provider token cache. */
export class ApnsSigner {
	private key?: Promise<CryptoKey>;
	private jwt?: { value: string; at: number };
	private readonly env: ApnsEnv;
	constructor(env: ApnsEnv) {
		this.env = env;
	}
	async token(now = Date.now()): Promise<string> {
		if (this.jwt && now - this.jwt.at < JWT_TTL_MS) return this.jwt.value;
		this.key ??= importEs256(this.env.APNS_KEY);
		const value = await signJwt(await this.key, { alg: "ES256", kid: this.env.APNS_KEY_ID }, { iss: this.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
		this.jwt = { value, at: now };
		return value;
	}
	forget(): void {
		this.jwt = undefined;
	}
}

export async function sendApns(
	signer: ApnsSigner,
	env: ApnsEnv,
	device: { t: string; s: boolean },
	body: string,
	m: PushMessage,
	doFetch: typeof fetch = fetch,
): Promise<SendResult> {
	const url = `${device.s ? APNS_SANDBOX_HOST : APNS_HOST}/3/device/${device.t}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		let res: Response;
		try {
			res = await doFetch(url, { method: "POST", headers: apnsHeaders(await signer.token(), env.APNS_TOPIC, m), body });
		} catch {
			return { kind: "failed", status: 0, reason: "network" };
		}
		if (res.status === 200) {
			await res.body?.cancel();
			return { kind: "sent" };
		}
		let reason = "";
		try {
			reason = String(((await res.json()) as { reason?: string }).reason ?? "");
		} catch {}
		if (res.status === 410 || (res.status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))) return { kind: "gone" };
		if (res.status === 429) return { kind: "limited", retryAfter: res.headers.get("retry-after") ?? undefined };
		if (res.status === 403 && reason === "ExpiredProviderToken" && attempt === 0) {
			signer.forget();
			continue;
		}
		return { kind: "failed", status: res.status, reason };
	}
	return { kind: "failed", status: 403, reason: "ExpiredProviderToken" };
}
