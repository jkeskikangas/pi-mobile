// Apple Push Notification service over HTTP/2 with token auth, no dependencies.
// The hub signs an ES256 JWT with the user's own `.p8` key (kid = key id, iss = team id) and posts
// a generic alert; the real title and body travel sealed to the device key, opened on the phone by
// a Notification Service Extension. Apple sees neither session names nor questions.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";

export interface ApnsConfig {
	/** Path to the AuthKey_XXXXXXXXXX.p8 file from the Apple developer account. */
	keyFile: string;
	/** The key's id (10 characters, in the file name). */
	keyId: string;
	/** Apple developer team id. */
	teamId: string;
	/** The app's bundle id (`apns-topic`). */
	topic: string;
	/** Default environment for tokens that don't say; a token's own `sandbox` flag wins. */
	sandbox?: boolean;
}

export interface ApnsToken {
	/** Device token, hex. */
	token: string;
	/** Development build (Xcode): api.sandbox.push.apple.com. */
	sandbox?: boolean;
}

export type ApnsResult = "sent" | "gone" | "failed";

export const APNS_HOST = "https://api.push.apple.com";
export const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";
/** Apple accepts a token for an hour and rejects refreshing more often than every 20 minutes. */
const JWT_TTL_MS = 30 * 60_000;

export function apnsConfigured(c: Partial<ApnsConfig> | undefined): c is ApnsConfig {
	return !!(c?.keyFile && c.keyId && c.teamId && c.topic);
}

export function isApnsToken(t: unknown): t is ApnsToken {
	return !!t && typeof (t as ApnsToken).token === "string" && /^[0-9a-fA-F]{32,200}$/.test((t as ApnsToken).token);
}

/** ES256 provider token: header `{alg, kid}`, claims `{iss, iat}`. */
export function apnsJwt(key: KeyObject, keyId: string, teamId: string, now = Date.now()): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${enc({ alg: "ES256", kid: keyId })}.${enc({ iss: teamId, iat: Math.floor(now / 1000) })}`;
	const sig = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
	return `${unsigned}.${sig.toString("base64url")}`;
}

export interface ApnsMessage {
	/** Sealed `{ title, body, agent, machine? }` (see `seal` in crypto.ts), opened by the phone. */
	sealed: string;
	/** Groups notifications per session (`thread-id`). */
	thread?: string;
	urgent?: boolean;
	/** Generic visible text; Apple sees only this. */
	body?: string;
}

/** The exact JSON posted to Apple. */
export function apnsPayload(m: ApnsMessage): unknown {
	return {
		aps: {
			alert: { title: "pi", body: m.body ?? "New activity" },
			"mutable-content": 1,
			sound: "default",
			...(m.thread ? { "thread-id": m.thread } : {}),
			...(m.urgent ? { "interruption-level": "time-sensitive" } : {}),
		},
		sealed: m.sealed,
	};
}

export class ApnsClient {
	private key?: KeyObject;
	private jwt?: { value: string; at: number };
	private sessions = new Map<string, ClientHttp2Session>();

	/** `hosts` is replaceable in tests (a local http2 server). */
	readonly config: ApnsConfig;
	private readonly hosts: { production: string; sandbox: string };

	constructor(config: ApnsConfig, hosts = { production: APNS_HOST, sandbox: APNS_SANDBOX_HOST }) {
		this.config = config;
		this.hosts = hosts;
	}

	/** Cached provider token, re-signed every 30 minutes. */
	providerToken(now = Date.now()): string {
		this.key ??= createPrivateKey(readFileSync(this.config.keyFile, "utf8"));
		if (!this.jwt || now - this.jwt.at >= JWT_TTL_MS) this.jwt = { value: apnsJwt(this.key, this.config.keyId, this.config.teamId, now), at: now };
		return this.jwt.value;
	}

	private session(origin: string): ClientHttp2Session {
		let s = this.sessions.get(origin);
		if (!s || s.closed || s.destroyed) {
			s = connect(origin);
			s.on("error", () => {});
			s.on("close", () => this.sessions.get(origin) === s && this.sessions.delete(origin));
			s.unref();
			this.sessions.set(origin, s);
		}
		return s;
	}

	async send(device: ApnsToken, m: ApnsMessage): Promise<ApnsResult> {
		try {
			const sandbox = device.sandbox ?? this.config.sandbox ?? false;
			const origin = sandbox ? this.hosts.sandbox : this.hosts.production;
			const body = JSON.stringify(apnsPayload(m));
			const req = this.session(origin).request({
				":method": "POST",
				":path": `/3/device/${device.token}`,
				authorization: `bearer ${this.providerToken()}`,
				"apns-topic": this.config.topic,
				"apns-push-type": "alert",
				"apns-priority": "10",
				"apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
				"content-type": "application/json",
			});
			const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
				let status = 0;
				let text = "";
				const timer = setTimeout(() => req.close(), 10_000);
				req.on("response", (h) => (status = Number(h[":status"])));
				req.setEncoding("utf8");
				req.on("data", (c) => (text += c));
				req.on("end", () => (clearTimeout(timer), resolve({ status, text })));
				req.on("error", (e) => (clearTimeout(timer), reject(e)));
				req.end(body);
			});
			if (status === 200) return "sent";
			let reason = "";
			try {
				reason = JSON.parse(text).reason ?? "";
			} catch {}
			if (status === 410 || (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))) return "gone";
			if (status === 403 && reason === "ExpiredProviderToken") this.jwt = undefined;
			return "failed";
		} catch {
			return "failed";
		}
	}

	close(): void {
		for (const s of this.sessions.values()) s.close();
		this.sessions.clear();
	}
}
