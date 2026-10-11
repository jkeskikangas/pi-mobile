// Voice input: from what was said to what was meant. Speech carries more than typing but is
// redundant (fillers, restarts), self-correcting ("no wait, the other file") and loosely named
// ("the get user thing"). Distillation produces the message the developer would have typed.

import type { Complete } from "./model.ts";
import { matchNames, type NameMatch, salientFiles, type Vocabulary } from "./vocab.ts";

export interface Distilled {
	/** The written message, ready for the editor. */
	text: string;
	/** Short questions about things that were genuinely ambiguous. */
	unclear: string[];
	/** "model" when a model rewrote it, "heuristic" when the local fallback did. */
	by: "model" | "heuristic";
}

export const DISTILL_SYSTEM = `You turn a developer's spoken dictation into the written message they meant to type to an AI coding agent working in their repository. You are an editor, not an assistant: never answer, solve, or comment on the request.

Rules:
1. Intent, not transcript. Keep the speaker's final intent only: when they revise themselves ("no wait", "actually", "I mean", "scratch that", or simply restating something differently), keep the revision and drop what it replaced. Remove fillers, false starts, repetitions and thinking aloud that does not change the request.
2. Lose nothing that matters. Keep every concrete detail: names, numbers, versions, constraints ("don't touch X", "keep the API"), ordering, conditions, preferences, priorities and the reason if one was given. Do not add requirements, steps, assumptions, or politeness that were not spoken.
3. Real names. Speech recognition mangles code names. When a spoken phrase plausibly refers to a name in WORKSPACE NAMES, PROJECT FILES or CODE SYMBOLS (judge by sound, not spelling), write that exact name in backticks (e.g. "get user by id" -> \`getUserById\`, "orthodotts" or "off dot ts" -> \`auth.ts\`). A file or symbol the dictation names that is not in those lists was almost certainly misheard: use the listed name that sounds most alike when one fits the context; if none does, keep the words and ask under UNCLEAR. Write other spoken code (paths, flags, commands) the way it is written ("src slash components" -> \`src/components\`, "dash dash force" -> \`--force\`). Never invent names.
4. Shape for reading. A simple request stays one or two plain sentences. Several asks become a one-line goal followed by a short numbered list in the order they should happen. Keep the speaker's voice: first person, imperative, their register. No headings, no preamble.
5. Resolve references from RECENT CONTEXT ("that", "what you suggested", "the second option") only when the context makes them unambiguous; then name the thing explicitly.
6. Ambiguity is surfaced, not guessed away. If something that matters has two reasonable readings that context does not settle, write the most likely reading and add a short question for it under UNCLEAR. Do not flag trivia.
7. Write in the language the speaker used. If the dictation is empty or only noise, output nothing.
8. Editing by voice. If the dictation is an instruction about the ALREADY TYPED text ("make that a list", "drop the second point", "change X to Y", "shorter", "start over"), apply it to that text and output the edited message; do not append the instruction.
9. PERSONAL DICTIONARY lists corrections the developer made to earlier dictations: when the same words come up, write them the corrected way.

Output exactly the message. If there are unclear points, end with a line containing only ---unclear--- followed by one "- question" line each.`;

function lastAssistantText(branch: readonly any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : undefined;
		if (m?.role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * Removes recogniser loops: a word or phrase (up to ~60 characters) repeated 4+ times in a row is
 * kept once ("thank you. thank you. thank you. thank you." → "thank you."). Real speech rarely
 * repeats anything four times; recognisers do on silence and noise.
 */
export function collapseRepeats(text: string): string {
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	const key = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	const out: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		let skipped = false;
		for (let n = 1; n <= 8 && i + n * 4 <= tokens.length; n++) {
			const unit = tokens.slice(i, i + n);
			if (unit.join(" ").length > 60) break;
			const same = (at: number) => unit.every((t, k) => key(t) === key(tokens[at + k] ?? ""));
			let reps = 1;
			while (same(i + reps * n)) reps++;
			if (reps >= 4) {
				out.push(...tokens.slice(i + (reps - 1) * n, i + reps * n)); // the last copy keeps its punctuation
				i += reps * n;
				skipped = true;
				break;
			}
		}
		if (!skipped) out.push(tokens[i++]);
	}
	return out.join(" ");
}

export function distillPrompt(raw: string, v: Vocabulary, branch: readonly any[], draft = ""): string {
	// Loose matches: the model judges plausibility ("off dot ts" may well be auth.ts); the local
	// fallback only uses near-exact ones.
	const matches = matchNames(raw, v, 30, 0.5);
	const names = [
		...matches.map((m) => `${m.name}   (maybe heard as "${m.heard}")`),
		...v.recent.slice(0, 60).filter((r) => !matches.some((m) => m.name === r)),
	];
	const files = salientFiles(v, 250).filter((f) => !matches.some((m) => m.name === f));
	const symbols = (v.symbols ?? []).slice(0, 300).filter((s) => !matches.some((m) => m.name === s));
	const last = lastAssistantText(branch);
	const parts = [
		`PROJECT: ${v.project}${v.branch ? ` (branch ${v.branch})` : ""}`,
		names.length ? `WORKSPACE NAMES:\n${names.join("\n")}` : "WORKSPACE NAMES: (none)",
		files.length ? `PROJECT FILES${v.files.length > files.length ? ` (${files.length} of ${v.files.length})` : ""}:\n${files.join("\n")}` : "",
		v.learned?.length ? `PERSONAL DICTIONARY:\n${v.learned.map((c) => `"${c.from}" -> ${c.to}`).join("\n")}` : "",
		symbols.length ? `CODE SYMBOLS${(v.symbols?.length ?? 0) > symbols.length ? " (most used)" : ""}: ${symbols.join(", ")}` : "",
		last ? `RECENT CONTEXT (the agent's last message, for resolving references):\n${last.length > 2500 ? `…${last.slice(-2500)}` : last}` : "",
		draft.trim() ? `ALREADY TYPED in the editor (the dictation continues or amends it; output the combined message):\n${draft}` : "",
		`DICTATION:\n${raw}`,
	];
	return parts.filter(Boolean).join("\n\n");
}

export function parseDistilled(out: string): Omit<Distilled, "by"> {
	const text = out.replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/m, "$1").trim();
	const [body, tail = ""] = text.split(/^\s*-{3}\s*unclear\s*-{3}\s*$/im);
	const unclear = tail
		.split("\n")
		.map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
		.filter(Boolean);
	return { text: body.trim(), unclear };
}

// ── heuristic fallback ──────────────────────────────────────────────────────────────────────────────────

const FILLERS = /\b(?:um+|uh+|erm+|er|ah+|hmm+|you know|i mean,?\s(?=\w)|sort of|kind of|like,)\s*/gi;
// "Scratch that" drops the sentence before it (or the start of the current one) along with itself.
const SCRATCH = /[^.!?]*[.!?]?\s*\b(?:scratch that|strike that|never ?mind that|delete that)\b[.,!?]?\s*/gi;
const NO_WAIT = /\b(?:no wait|no,? sorry|sorry,? i mean|actually,? no|or rather|no no)\b/i;

/** Local, model-free cleanup: fillers, explicit backtracks, high-confidence names, punctuation. */
export function heuristicDistill(raw: string, v: Vocabulary): Distilled {
	let t = ` ${raw.trim()} `;
	t = t.replace(SCRATCH, " ");
	// Where a mid-sentence correction starts is a judgement call; without a model, flag it instead of guessing.
	const unclear = NO_WAIT.test(t) ? ["You corrected yourself mid-sentence; check the wording kept the right version."] : [];
	t = t.replace(FILLERS, "");
	t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
	const matches: NameMatch[] = matchNames(t, v).filter((m) => m.score >= 0.8 && m.heard.length >= 5);
	for (const m of matches) {
		const re = new RegExp(`\\b${m.heard.split(" ").map(escapeRe).join("[\\s.,-]+")}\\b`, "i");
		t = t.replace(re, `\`${m.name.includes("/") ? m.name.split("/").pop() : m.name}\``);
	}
	t = t.replace(/\s+([,.!?])/g, "$1").replace(/\s+/g, " ").trim();
	if (t && !/[.!?]$/.test(t)) t += ".";
	t = t.charAt(0).toUpperCase() + t.slice(1);
	return { text: t, unclear, by: "heuristic" };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Distils with a model; falls back to the heuristic when the model is unreachable or returns nothing. */
export async function distill(
	raw: string,
	v: Vocabulary,
	branch: readonly any[],
	complete: Complete | undefined,
	opts: { draft?: string; signal?: AbortSignal } = {},
): Promise<Distilled & { error?: string }> {
	raw = collapseRepeats(raw);
	if (!raw.trim()) return { text: "", unclear: [], by: "heuristic" };
	if (complete) {
		try {
			const out = await complete(DISTILL_SYSTEM, distillPrompt(raw, v, branch, opts.draft), { signal: opts.signal, maxTokens: 2000 });
			const parsed = parseDistilled(out);
			if (parsed.text) return { ...parsed, by: "model" };
		} catch (e: any) {
			if (opts.signal?.aborted) throw e;
			return { ...heuristicDistill(raw, v), error: String(e?.message ?? e) };
		}
	}
	return heuristicDistill(raw, v);
}

/** Editor text: the message, then any unclear points as a short list the user can keep or delete. */
export function editorText(d: Pick<Distilled, "text" | "unclear">): string {
	if (!d.unclear.length) return d.text;
	return `${d.text}\n\nUnclear:\n${d.unclear.map((u) => `- ${u}`).join("\n")}`;
}
