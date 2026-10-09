// Writing for the ear. A spoken reply is serial and transient: the listener cannot skim, scroll
// back, or see structure. So it leads with the outcome, carries one idea per sentence, rounds
// numbers, names files by basename, never reads code, and offers detail instead of dumping it.

import { basename } from "node:path";
import type { Complete } from "./model.ts";
import { sayName } from "./vocab.ts";

/** What happened in the latest run, compact enough for a small model and for the voice layer. */
export interface RunDigest {
	request: string;
	edits: { path: string; added: number; removed: number }[];
	commands: { command: string; ok: boolean; tail: string }[];
	errors: string[];
	final: string;
	aborted: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added++;
		else if (l.startsWith("-") && !l.startsWith("---")) removed++;
	}
	return { added, removed };
}

const EDIT_TOOLS = /^(edit|write|multi_?edit|apply_?patch|str_replace)/i;
const SHELL_TOOLS = /^(bash|shell|exec|run)/i;

/** Digest of the branch since the last user message. */
export function runDigest(branch: readonly any[]): RunDigest {
	let start = branch.length;
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : undefined;
		if (m?.role === "user") {
			start = i;
			break;
		}
	}
	const d: RunDigest = { request: "", edits: [], commands: [], errors: [], final: "", aborted: false };
	const calls = new Map<string, { name: string; args: any }>();
	const edits = new Map<string, { path: string; added: number; removed: number }>();
	for (let i = start; i < branch.length; i++) {
		const m = branch[i]?.type === "message" ? branch[i].message : undefined;
		if (!m) continue;
		if (m.role === "user") d.request = textOf(m.content).slice(0, 1500);
		else if (m.role === "assistant") {
			for (const c of m.content ?? []) if (c.type === "toolCall") calls.set(c.id, { name: c.name, args: c.arguments ?? {} });
			const t = textOf(m.content).trim();
			if (t) d.final = t;
			if (m.stopReason === "aborted") d.aborted = true;
			if (m.stopReason === "error" && m.errorMessage) d.errors.push(String(m.errorMessage).slice(0, 300));
		} else if (m.role === "toolResult") {
			const call = calls.get(m.toolCallId);
			const name = m.toolName ?? call?.name ?? "";
			const out = textOf(m.content);
			if (EDIT_TOOLS.test(name)) {
				const paths = editPaths(call?.args);
				const stats = typeof m.details?.diff === "string" ? diffStats(m.details.diff) : { added: 0, removed: 0 };
				for (const [k, p] of paths.entries()) {
					const e = edits.get(p) ?? { path: p, added: 0, removed: 0 };
					if (k === 0) {
						e.added += stats.added;
						e.removed += stats.removed;
					}
					edits.set(p, e);
				}
				if (m.isError) d.errors.push(`${name} failed: ${out.slice(0, 200)}`);
			} else if (SHELL_TOOLS.test(name)) {
				const command = String(call?.args?.command ?? "").split("\n")[0].slice(0, 200);
				d.commands.push({ command, ok: !m.isError, tail: out.trim().split("\n").slice(-6).join("\n").slice(-600) });
			} else if (m.isError) d.errors.push(`${name} failed: ${out.slice(0, 200)}`);
		} else if (m.role === "bashExecution") {
			d.commands.push({ command: String(m.command).slice(0, 200), ok: m.exitCode === 0, tail: String(m.output ?? "").trim().split("\n").slice(-6).join("\n") });
		}
	}
	d.edits = [...edits.values()];
	return d;
}

function editPaths(args: any): string[] {
	if (!args || typeof args !== "object") return [];
	const out = new Set<string>();
	const p = args.path ?? args.file_path;
	if (typeof p === "string") out.add(p);
	for (const v of Object.values(args)) if (Array.isArray(v)) for (const e of v) if (typeof e?.path === "string") out.add(e.path);
	return [...out];
}

export function digestText(d: RunDigest): string {
	const lines = [`REQUEST: ${d.request || "(none)"}`];
	if (d.aborted) lines.push("STOPPED by the user before finishing.");
	if (d.edits.length)
		lines.push(`FILES CHANGED: ${d.edits.map((e) => `${e.path} (+${e.added} -${e.removed})`).join(", ")}`);
	for (const c of d.commands.slice(-6)) lines.push(`COMMAND ${c.ok ? "ok" : "FAILED"}: ${c.command}${c.ok ? "" : `\n  last output: ${c.tail.replace(/\n/g, "\n  ")}`}`);
	for (const e of d.errors.slice(-4)) lines.push(`ERROR: ${e}`);
	lines.push(`AGENT'S WRITTEN REPLY:\n${d.final.length > 6000 ? `${d.final.slice(0, 3000)}\n…\n${d.final.slice(-3000)}` : d.final || "(none)"}`);
	return lines.join("\n");
}

export type Attention = "eyes-busy" | "glance";

export const BRIEF_SYSTEM = (mode: Attention) => `You turn a coding agent's written report into what a voice assistant says aloud to the developer. ${
	mode === "eyes-busy"
		? "The developer is driving, running, cycling or cooking: they cannot look at a screen and are only half listening."
		: "The developer is listening on their phone and may glance at the screen."
} The full written report stays in their transcript for later.

Rules for the spoken brief:
- Lead with the outcome in the first sentence: done, partly done, blocked, failed, or a question for them.
- ${mode === "eyes-busy" ? "At most 2 short sentences, about 30 words in total." : "At most 3 short sentences, about 50 words in total."} One idea per sentence. Plain spoken language, contractions are fine.
- If the agent asks the developer something, end with that question, phrased so it can be answered with yes, no, or one short phrase. Offer at most two options.
- No code, no symbols, no markdown, no URLs, no full paths. Name a file by its base name the way a person says it ("auth dot ts"); name a function in words ("get user by ID"). Round numbers ("about forty lines", "three of twelve tests failed").
- Never pad: no greetings, no "the agent", no restating the request, no "let me know".
- Do not invent anything that the report does not say.
${mode === "eyes-busy" ? "- If something needs visual review (a diff, a UI), say it is waiting for them at a screen.\n" : ""}
Then, only if there is meaningful detail they might want, add a line "MORE:" with up to two short topics they could ask about, e.g. "MORE: the failing test names; the changed files".`;

export interface Brief {
	speech: string;
	more: string[];
}

export function parseBrief(out: string): Brief {
	const [speech, more = ""] = out.split(/^\s*MORE:\s*/im);
	return {
		speech: speakable(speech.trim()),
		more: more
			.split(/[;\n]/)
			.map((s) => s.trim().replace(/\.$/, ""))
			.filter(Boolean)
			.slice(0, 2),
	};
}

/** The spoken brief of the latest run; deterministic fallback when no model is reachable. */
export async function brief(d: RunDigest, mode: Attention, complete?: Complete, signal?: AbortSignal): Promise<Brief & { by: "model" | "heuristic" }> {
	if (complete) {
		try {
			const b = parseBrief(await complete(BRIEF_SYSTEM(mode), digestText(d), { signal, maxTokens: 400 }));
			if (b.speech) return { ...b, by: "model" };
		} catch (e) {
			if (signal?.aborted) throw e;
		}
	}
	return { ...heuristicBrief(d, mode), by: "heuristic" };
}

export function heuristicBrief(d: RunDigest, mode: Attention): Brief {
	const parts: string[] = [];
	if (d.aborted) parts.push("Stopped.");
	const failed = d.commands.filter((c) => !c.ok);
	const first = firstSentences(speakable(d.final), mode === "eyes-busy" ? 1 : 2);
	if (first) parts.push(first);
	else if (d.edits.length) parts.push(`Changed ${countWord(d.edits.length, "file")}.`);
	if (failed.length && !/fail|error/i.test(first)) parts.push(`${countWord(failed.length, "command")} failed.`);
	const question = lastQuestion(d.final);
	if (question && !parts.join(" ").includes(question)) parts.push(question);
	const more: string[] = [];
	if (d.edits.length) more.push("the changed files");
	if (failed.length) more.push("what failed");
	return { speech: parts.join(" ") || "Done.", more };
}

function lastQuestion(text: string): string | undefined {
	const qs = speakable(text).match(/[^.!?]*\?/g);
	const q = qs?.[qs.length - 1]?.trim();
	return q && q.split(" ").length <= 30 ? q : undefined;
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export function countWord(n: number, noun: string): string {
	return `${n <= 10 ? SMALL[n] : String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function firstSentences(text: string, n: number): string {
	const s = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? (text ? [text] : []);
	return s.slice(0, n).join("").trim();
}

/**
 * Deterministic text-to-ear conversion: drops code blocks, tables and URLs, flattens markdown,
 * turns paths into spoken base names and identifiers into words.
 */
export function speakable(text: string): string {
	let t = String(text ?? "");
	t = t.replace(/```[\s\S]*?(```|$)/g, " ");
	t = t.replace(/^\s*\|.*\|\s*$/gm, " ");
	t = t.replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1");
	t = t.replace(/https?:\/\/\S+/g, "a link");
	t = t.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.");
	t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*?)[.;:]?\s*$/gm, "$1.");
	t = t.replace(/`([^`]+)`/g, (_, code: string) => speakCode(code));
	t = t.replace(/(?:^|(?<=\s))((?:[\w.-]+\/)+[\w.-]+)/g, (p: string) => sayName(basename(p)));
	t = t.replace(/\b([A-Za-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/g, (id: string) => sayName(id));
	t = t.replace(/\b([\w-]+)\.(ts|tsx|js|jsx|mjs|py|rs|go|md|json|yaml|yml|toml|sh|css|html|swift|kt|java|rb|sql)\b/g, (_m, b, ext) => `${sayName(b)} dot ${ext}`);
	t = t.replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)|[>#~]/g, "");
	t = t.replace(/\s*(->|=>|→)\s*/g, " to ");
	t = t.replace(/\s*&\s*/g, " and ");
	t = t.replace(/\s*\n+\s*/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/([.!?])\.+/g, "$1").replace(/\s{2,}/g, " ");
	return t.trim();
}

function speakCode(code: string): string {
	const c = code.trim();
	if (/^--?[\w-]+$/.test(c)) return c.replace(/^--/, "dash dash ").replace(/^-/, "dash ").replace(/-/g, " ");
	if (/^[\w./-]+$/.test(c)) return c.includes("/") ? sayName(basename(c)) : sayName(c);
	if (c.split(/\s+/).length <= 4 && !/[{}();=<>[\]]/.test(c)) return c;
	return "the code on screen";
}

// ── the agent's side ────────────────────────────────────────────────────────────────────────────────────────────

/** Appended to the agent's system prompt while someone follows the session by voice. */
export function agentVoiceNote(mode: Attention): string {
	return `

# Voice session
The user is following this session by voice through their phone${
		mode === "eyes-busy" ? " and cannot look at a screen (they may be driving, running, cycling or cooking)" : ""
	}. A separate voice layer reads them a short spoken summary of each of your replies.
- Their messages are speech transcripts: expect recognition errors, especially in code names, and map them to the real names in the workspace. If a request is genuinely ambiguous, ask one short question rather than guessing on anything risky.
- Start your final message with the outcome in one plain sentence, then details. When you need a decision, end with one question answerable with yes, no, or a short phrase, with at most two options.
- Do not ask them to read code, diffs or long output now; ${
		mode === "eyes-busy" ? "leave visual review for when they are back at a screen and say so." : "keep anything they must review short."
	}
- Before anything irreversible or outward-facing (pushing, deploying, deleting data, force operations, sending messages, spending money), stop and ask for explicit confirmation that names the action.`;
}
