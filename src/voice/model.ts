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
 * Picks the voice model: an explicit `provider/id` preference, else a fast model from the same
 * provider as the session's model, else any fast available model, else the session's model.
 */
export function pickVoiceModel(available: readonly ModelLike[], current: ModelLike | undefined, preferred?: string): ModelLike | undefined {
	if (preferred) {
		const [p, ...rest] = preferred.split("/");
		const hit = available.find((m) => m.provider === p && m.id === rest.join("/"));
		if (hit) return hit;
	}
	const fast = available.filter((m) => FAST.test(m.id) || FAST.test(m.name ?? ""));
	return fast.find((m) => m.provider === current?.provider) ?? fast[0] ?? current ?? available[0];
}

/** A `Complete` backed by pi's model registry, using the session's own credentials. */
export function registryComplete(ctx: () => ExtensionContext, preferred?: () => string | undefined): Complete {
	return async (system, user, opts) => {
		const c = ctx();
		const registry = c.modelRegistry as any;
		const scoped = (c.scopedModels ?? []).map((s: any) => s.model).filter(Boolean);
		const available: any[] = scoped.length ? scoped : (registry.getAvailable?.() ?? []);
		const model: any = pickVoiceModel(available, c.model as any, preferred?.()) ?? c.model;
		if (!model) throw new Error("no model available for voice");
		const stream = registry.streamSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
			{ reasoning: "minimal", maxTokens: opts?.maxTokens ?? 1500, signal: opts?.signal, cacheRetention: "none" },
		);
		const msg = await stream.result();
		if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || `voice model ${msg.stopReason}`);
		return (msg.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
	};
}
