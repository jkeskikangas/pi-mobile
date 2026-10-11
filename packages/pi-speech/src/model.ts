// One quick text completion on a model the user already has credentials for. Voice work (intent
// distillation, spoken briefs) needs speed far more than depth, so a fast tier model is preferred.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST = /haiku|mini|flash|lite|luna|spark|fast|small/i;

interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	input?: string[];
}

/** Text completion: `(system, user) → text`. Injectable so tests and alternative hosts need no model. */
export type Complete = (system: string, user: string, opts?: { signal?: AbortSignal; maxTokens?: number }) => Promise<string>;

/**
 * Voice model candidates, best first: an explicit `provider/id` preference, fast models from the
 * session's provider, other fast models, then the session's own model (which is known to work).
 */
export function voiceModelCandidates(available: readonly ModelLike[], current: ModelLike | undefined, preferred?: string): ModelLike[] {
	const out: ModelLike[] = [];
	const add = (m: ModelLike | undefined) => {
		if (m && !out.some((x) => x.provider === m.provider && x.id === m.id)) out.push(m);
	};
	if (preferred) {
		const [p, ...rest] = preferred.split("/");
		add(available.find((m) => m.provider === p && m.id === rest.join("/")));
	}
	const fast = available.filter((m) => FAST.test(m.id) || FAST.test(m.name ?? ""));
	for (const m of fast) if (m.provider === current?.provider) add(m);
	for (const m of fast) add(m);
	add(current);
	return out;
}

export function pickVoiceModel(available: readonly ModelLike[], current: ModelLike | undefined, preferred?: string): ModelLike | undefined {
	return voiceModelCandidates(available, current, preferred)[0] ?? available[0];
}

const key = (m: ModelLike) => `${m.provider}/${m.id}`;

/**
 * A `Complete` backed by pi's model registry, using the session's own credentials. A model that
 * fails (not offered on this account, no quota) is skipped for ten minutes and the next tried.
 */
export function registryComplete(ctx: () => ExtensionContext, preferred?: () => string | undefined): Complete {
	const failed = new Map<string, number>();
	let good: string | undefined;
	return async (system, user, opts) => {
		const c = ctx();
		const registry = c.modelRegistry as any;
		const scoped = (c.scopedModels ?? []).map((s: any) => s.model).filter(Boolean);
		const available: any[] = scoped.length ? scoped : (registry.getAvailable?.() ?? []);
		const now = Date.now();
		let candidates = voiceModelCandidates(available, c.model as any, preferred?.()).filter((m) => !(failed.get(key(m))! > now));
		if (good) candidates = [...candidates.filter((m) => key(m) === good), ...candidates.filter((m) => key(m) !== good)];
		if (!candidates.length && c.model) candidates = [c.model as any];
		if (!candidates.length) throw new Error("no model available for voice");
		let lastError: unknown;
		for (const model of candidates.slice(0, 4)) {
			try {
				const stream = registry.streamSimple(
					model,
					{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
					{ reasoning: "minimal", maxTokens: opts?.maxTokens ?? 1500, signal: opts?.signal, cacheRetention: "none" },
				);
				const msg = await stream.result();
				if (msg.stopReason === "aborted" || opts?.signal?.aborted) throw new Error("aborted");
				if (msg.stopReason === "error") throw Object.assign(new Error(msg.errorMessage || "voice model error"), { model: true });
				good = key(model);
				return (msg.content as any[])
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("")
					.trim();
			} catch (e: any) {
				if (opts?.signal?.aborted) throw e;
				lastError = e;
				failed.set(key(model), Date.now() + 10 * 60_000);
				if (good === key(model)) good = undefined;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};
}
