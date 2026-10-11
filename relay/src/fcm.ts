// Firebase Cloud Messaging HTTP v1 with a service-account OAuth token, no SDK.

import type { PushMessage, SendResult } from "./apns.ts";
import { importRs256, signJwt } from "./jwt.ts";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const FCM_MAX_PAYLOAD = 4096;
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export interface ServiceAccount {
	project_id: string;
	client_email: string;
	private_key: string;
	token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
	const sa = JSON.parse(json) as ServiceAccount;
	if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error("FCM_SERVICE_ACCOUNT is missing project_id/client_email/private_key");
	return sa;
}

/** RFC 7523 JWT bearer assertion for Google's token endpoint. */
export async function fcmAssertion(key: CryptoKey, sa: ServiceAccount, now = Date.now()): Promise<string> {
	const iat = Math.floor(now / 1000);
	return signJwt(key, { alg: "RS256", typ: "JWT" }, { iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri ?? DEFAULT_TOKEN_URI, iat, exp: iat + 3600 });
}

export function fcmMessage(token: string, m: PushMessage): unknown {
	return {
		message: {
			token,
			data: { sealed: m.sealed, ...(m.urgent ? { urgent: "1" } : {}) },
			android: { priority: "HIGH", ttl: "3600s", ...(m.collapse ? { collapse_key: m.collapse } : {}) },
		},
	};
}

/** Per-isolate OAuth access token cache. */
export class FcmAuth {
	readonly sa: ServiceAccount;
	private key?: Promise<CryptoKey>;
	private access?: { value: string; until: number };
	constructor(sa: ServiceAccount) {
		this.sa = sa;
	}
	async token(doFetch: typeof fetch, now = Date.now()): Promise<string> {
		if (this.access && now < this.access.until) return this.access.value;
		this.key ??= importRs256(this.sa.private_key);
		const assertion = await fcmAssertion(await this.key, this.sa, now);
		const res = await doFetch(this.sa.token_uri ?? DEFAULT_TOKEN_URI, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
		});
		if (!res.ok) throw new Error(`oauth ${res.status}`);
		const j = (await res.json()) as { access_token: string; expires_in?: number };
		// Refresh five minutes early.
		this.access = { value: j.access_token, until: now + Math.max(60, (j.expires_in ?? 3600) - 300) * 1000 };
		return j.access_token;
	}
	forget(): void {
		this.access = undefined;
	}
}

export async function sendFcm(auth: FcmAuth, token: string, body: string, doFetch: typeof fetch = fetch): Promise<SendResult> {
	let res: Response;
	try {
		const access = await auth.token(doFetch);
		res = await doFetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(auth.sa.project_id)}/messages:send`, {
			method: "POST",
			headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
			body,
		});
	} catch {
		return { kind: "failed", status: 0, reason: "network" };
	}
	if (res.ok) {
		await res.body?.cancel();
		return { kind: "sent" };
	}
	let code = "";
	try {
		const j = (await res.json()) as { error?: { status?: string; details?: { errorCode?: string }[] } };
		code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status ?? "";
	} catch {}
	if (res.status === 404 || code === "UNREGISTERED") return { kind: "gone" };
	if (res.status === 429) return { kind: "limited", retryAfter: res.headers.get("retry-after") ?? undefined };
	if (res.status === 401) auth.forget();
	return { kind: "failed", status: res.status, reason: code };
}
