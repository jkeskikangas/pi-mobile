// Push through the open-source relay (relay/): the App Store app's APNs key lives only there.
// The hub sends `seal(deviceKey, {title, body, agent, machine})` plus an opaque capability the phone got
// from the relay; the relay sees ciphertext and a device token, never names or text. Never log caps or payloads.

export interface RelayTarget {
	/** Relay base URL, https only, e.g. `https://pi-push-relay.example.workers.dev`. */
	url: string;
	/** Opaque capability from the relay's `POST /v1/register`. */
	cap: string;
}

export interface RelayMessage {
	sealed: string;
	urgent?: boolean;
	collapse?: string;
}

export type RelayResult = "sent" | "gone" | "limited" | "failed";

/** Normalized relay URL (no trailing slash), or undefined unless it is plain https without credentials, query or fragment. */
export function relayUrl(u: unknown): string | undefined {
	if (typeof u !== "string" || u.length > 512) return undefined;
	try {
		const x = new URL(u);
		if (x.protocol !== "https:" || x.username || x.password || x.search || x.hash) return undefined;
		return `${x.origin}${x.pathname.replace(/\/+$/, "")}`;
	} catch {
		return undefined;
	}
}

export function isRelayTarget(t: unknown): t is RelayTarget {
	const r = t as RelayTarget;
	return !!r && typeof r === "object" && !!relayUrl(r.url) && typeof r.cap === "string" && /^[\w-]{40,2048}$/.test(r.cap);
}

/** Sends to relays, honouring each relay's Retry-After by skipping sends until it passes. */
export class RelayClient {
	private readonly pausedUntil = new Map<string, number>();
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number;

	constructor(fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = 10_000) {
		this.fetch = fetchImpl;
		this.timeoutMs = timeoutMs;
	}

	async send(target: RelayTarget, m: RelayMessage, now = Date.now()): Promise<RelayResult> {
		const base = relayUrl(target.url);
		if (!base) return "gone";
		if ((this.pausedUntil.get(base) ?? 0) > now) return "limited";
		const body = JSON.stringify({ cap: target.cap, sealed: m.sealed, ...(m.urgent ? { urgent: true } : {}), ...(m.collapse ? { collapse: m.collapse } : {}) });
		let res: Response;
		try {
			res = await this.fetch(`${base}/v1/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal: AbortSignal.timeout(this.timeoutMs),
				redirect: "error",
			});
		} catch {
			return "failed";
		}
		await res.body?.cancel().catch(() => {});
		if (res.status === 200) return "sent";
		if (res.status === 410) return "gone";
		if (res.status === 429) {
			this.pausedUntil.set(base, now + retryAfterMs(res.headers.get("retry-after"), now));
			return "limited";
		}
		return "failed";
	}
}

/** Retry-After as seconds or an HTTP date; 60 s when missing, capped at an hour. */
export function retryAfterMs(h: string | null, now = Date.now()): number {
	const s = Number(h);
	const ms = h && Number.isFinite(s) ? s * 1000 : h ? Date.parse(h) - now : NaN;
	return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), 3_600_000) : 60_000;
}
