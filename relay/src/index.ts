// pi push relay: turns a stateless capability plus a sealed blob into one APNs/FCM push.
// Privacy: sees a device token (inside the cap), ciphertext it cannot open, and a generic alert.
// Never log request bodies, caps, tokens or payloads.

import { APNS_MAX_PAYLOAD, ApnsSigner, apnsPayload, sendApns, type PushMessage, type SendResult } from "./apns.ts";
import { sha256Hex } from "./b64.ts";
import { importCapKey, openCap, sealCap, validToken, type Platform } from "./cap.ts";
import { FCM_MAX_PAYLOAD, FcmAuth, fcmMessage, parseServiceAccount, sendFcm } from "./fcm.ts";

/** Workers rate limiting binding (structural, so no @cloudflare/workers-types needed). */
export interface RateLimit {
	limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
	CAP_KEY: string;
	APNS_KEY?: string;
	APNS_KEY_ID?: string;
	APNS_TEAM_ID?: string;
	APNS_TOPIC?: string;
	FCM_SERVICE_ACCOUNT?: string;
	REGISTER_LIMIT?: RateLimit;
	SEND_LIMIT?: RateLimit;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const MAX_BODY = 16 * 1024;

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
	if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return undefined;
	const text = await req.text();
	if (text.length > MAX_BODY) return undefined;
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function resultResponse(r: SendResult): Response {
	switch (r.kind) {
		case "sent":
			return json(200, { ok: true });
		case "gone":
			return json(410, { gone: true });
		case "limited":
			return json(429, { error: "upstream rate limited" }, r.retryAfter ? { "retry-after": r.retryAfter } : {});
		case "failed":
			// Apple/Google reason strings (e.g. "InvalidProviderToken") are not user data.
			return json(502, { error: "upstream failed", status: r.status, reason: r.reason ?? "" });
	}
}

/** Isolate-scoped state; rebuilt when secrets change (new deploy = new isolate). */
interface State {
	capKey: Promise<CryptoKey>;
	apns?: ApnsSigner;
	fcm?: FcmAuth;
}

export function createRelay(doFetch: typeof fetch = (...a) => fetch(...a)) {
	let state: State | undefined;
	let stateKey: string | undefined;
	const init = (env: Env): State => {
		// Keyed on the config itself, not the env object's identity, so the JWT cache survives across requests.
		const key = [env.CAP_KEY, env.APNS_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_TOPIC, env.FCM_SERVICE_ACCOUNT].join("\n");
		if (state && stateKey === key) return state;
		stateKey = key;
		state = {
			capKey: importCapKey(env.CAP_KEY),
			apns: env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC ? new ApnsSigner(env as Required<Env>) : undefined,
			fcm: env.FCM_SERVICE_ACCOUNT ? new FcmAuth(parseServiceAccount(env.FCM_SERVICE_ACCOUNT)) : undefined,
		};
		return state;
	};

	async function register(req: Request, env: Env, s: State): Promise<Response> {
		if (env.REGISTER_LIMIT) {
			const ip = req.headers.get("cf-connecting-ip") ?? "";
			if (!(await env.REGISTER_LIMIT.limit({ key: `r:${ip}` })).success) return json(429, { error: "rate limited" }, { "retry-after": "60" });
		}
		const b = await readJson(req);
		const p = b?.platform as Platform;
		if (p !== "apns" && p !== "fcm") return json(400, { error: "platform must be apns or fcm" });
		if ((p === "apns" && !s.apns) || (p === "fcm" && !s.fcm)) return json(501, { error: `${p} not configured on this relay` });
		if (!validToken(p, b!.token)) return json(400, { error: "bad token" });
		if (b!.sandbox !== undefined && typeof b!.sandbox !== "boolean") return json(400, { error: "bad sandbox" });
		const cap = await sealCap(await s.capKey, { p, t: b!.token as string, s: p === "apns" && b!.sandbox === true });
		return json(200, { cap });
	}

	async function send(req: Request, env: Env, s: State): Promise<Response> {
		const b = await readJson(req);
		if (!b || typeof b.cap !== "string" || typeof b.sealed !== "string" || !b.sealed) return json(400, { error: "need cap and sealed" });
		if (b.urgent !== undefined && typeof b.urgent !== "boolean") return json(400, { error: "bad urgent" });
		if (b.collapse !== undefined && (typeof b.collapse !== "string" || new TextEncoder().encode(b.collapse).length > 64)) return json(400, { error: "bad collapse" });
		const device = await openCap(await s.capKey, b.cap);
		// A cap this relay cannot open will never work again (wrong relay or rotated CAP_KEY): tell the hub to drop it.
		if (!device) return json(410, { gone: true, reason: "cap" });
		if (env.SEND_LIMIT) {
			const key = `s:${(await sha256Hex(`${device.p}:${device.t}`)).slice(0, 32)}`;
			if (!(await env.SEND_LIMIT.limit({ key })).success) return json(429, { error: "rate limited" }, { "retry-after": "60" });
		}
		const m: PushMessage = { sealed: b.sealed, urgent: b.urgent === true, collapse: b.collapse as string | undefined };
		if (device.p === "apns") {
			if (!s.apns) return json(501, { error: "apns not configured on this relay" });
			const body = JSON.stringify(apnsPayload(m));
			if (new TextEncoder().encode(body).length > APNS_MAX_PAYLOAD) return json(413, { error: "payload over 4 KB" });
			return resultResponse(await sendApns(s.apns, env as Required<Env>, device, body, m, doFetch));
		}
		if (!s.fcm) return json(501, { error: "fcm not configured on this relay" });
		const msg = fcmMessage(device.t, m) as { message: { data: unknown } };
		if (new TextEncoder().encode(JSON.stringify(msg.message.data)).length > FCM_MAX_PAYLOAD) return json(413, { error: "payload over 4 KB" });
		return resultResponse(await sendFcm(s.fcm, device.t, JSON.stringify(msg), doFetch));
	}

	return {
		async fetch(req: Request, env: Env): Promise<Response> {
			const { pathname } = new URL(req.url);
			if (req.method === "GET" && pathname === "/") return new Response("pi push relay: ok\n", { headers: { "content-type": "text/plain" } });
			if (req.method !== "POST" || (pathname !== "/v1/register" && pathname !== "/v1/send")) return json(404, { error: "not found" });
			let s: State;
			try {
				s = init(env);
				await s.capKey;
			} catch {
				state = undefined;
				return json(500, { error: "relay misconfigured" });
			}
			return pathname === "/v1/register" ? register(req, env, s) : send(req, env, s);
		},
	};
}

export default createRelay();
