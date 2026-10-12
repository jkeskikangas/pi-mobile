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

/**
 * Tool activity worth a listener's attention: anything touching production, data, deployment,
 * shared history, external services or money. Everything else is the agent's own business.
 */
export const SIGNIFICANT =
	/\b(prod|production|deploy\w*|release|publish|migrat\w*|drop\s+(?:table|database|schema)|truncate|delete\s+from|update\s+\w+\s+set|rm\s+-\w*r\w*f|git\s+push|--force|reset\s+--hard|kubectl|helm|terraform\s+(?:apply|destroy)|tofu\s+(?:apply|destroy)|psql|mysql|mongosh?|redis-cli|database_url|aws\s|gcloud|az\s|ssh\s|scp\s|curl\s+-X\s*(?:POST|PUT|PATCH|DELETE)|npm\s+publish|docker\s+push|stripe|payment|send\w*\s+(?:mail|email|message))\b/i;

export function isSignificant(text: string): boolean {
	return SIGNIFICANT.test(text);
}

/** Changed files grouped by the part of the system they belong to: "voice (3 files)". */
export function changedAreas(edits: RunDigest["edits"]): { area: string; files: number; lines: number }[] {
	const areas = new Map<string, { area: string; files: number; lines: number }>();
	for (const e of edits) {
		const parts = e.path.split("/").filter(Boolean);
		const dirs = parts.slice(0, -1).filter((p) => !/^(src|lib|app|pkg|internal|source)$/.test(p));
		// The nearest meaningful folder; under only generic ones (src/auth.ts), the file's own subject.
		const area = dirs.length ? dirs.slice(-1)[0] : (parts.at(-1) ?? "project").replace(/\.[^.]+$/, "").replace(/^index$/, "project root");
		const a = areas.get(area) ?? { area, files: 0, lines: 0 };
		a.files++;
		a.lines += e.added + e.removed;
		areas.set(area, a);
	}
	return [...areas.values()].sort((x, y) => y.lines - x.lines);
}

/**
 * The run as a report for the voice layer: what was asked, what changed and where (by area),
 * significant actions and failures that matter, and the agent's own written reply. Plain tool
 * chatter (reads, searches, routine commands) is left out on purpose.
 */
export function digestText(d: RunDigest): string {
	const lines = [`REQUEST: ${d.request || "(none)"}`];
	if (d.aborted) lines.push("STOPPED by the developer before finishing.");
	if (d.edits.length) {
		const total = d.edits.reduce((s, e) => s + e.added + e.removed, 0);
		lines.push(
			`AREAS CHANGED: ${changedAreas(d.edits)
				.map((a) => `${a.area} (${a.files} file${a.files > 1 ? "s" : ""})`)
				.join(", ")}; ${d.edits.length} files, about ${total} lines in total`,
		);
	}
	const significant = d.commands.filter((c) => isSignificant(c.command));
	for (const c of significant.slice(-4)) lines.push(`SIGNIFICANT ACTION ${c.ok ? "succeeded" : "FAILED"}: ${c.command}${c.ok ? "" : `\n  last output: ${c.tail.replace(/\n/g, "\n  ")}`}`);
	const failed = d.commands.filter((c) => !c.ok && !significant.includes(c));
	if (failed.length)
		lines.push(
			`FAILED COMMANDS (routine; matters only if the reply says the work is not done): ${failed
				.slice(-3)
				.map((c) => `${c.command} → ${c.tail.split("\n").slice(-2).join(" / ")}`)
				.join("; ")}`,
		);
	for (const e of d.errors.slice(-3)) lines.push(`ERROR: ${e}`);
	lines.push(`AGENT'S WRITTEN REPLY:\n${d.final.length > 6000 ? `${d.final.slice(0, 3000)}\n…\n${d.final.slice(-3000)}` : d.final || "(none)"}`);
	if (d.edits.length) lines.push(`FILES (only if the developer asks which files): ${d.edits.map((e) => e.path).join(", ")}`);
	return lines.join("\n");
}

export type Attention = "eyes-busy" | "glance";

/** Where the brief is heard: the phone (voice mode on the move) or the terminal (`/voice`, headphones at the desk). */
export type BriefSurface = "phone" | "terminal";

const AUDIENCE: Record<BriefSurface, Record<Attention, string>> = {
	phone: {
		"eyes-busy": "The developer is driving, running, cycling or cooking: they cannot look at a screen and are only half listening.",
		glance: "The developer is listening on their phone and may glance at the screen.",
	},
	terminal: {
		"eyes-busy": "The developer is at their computer with headphones on but cannot look at the screen right now (eyes-free): what you write is all they get until they look.",
		glance: "The developer is at their computer with headphones on and reads the agent's full answer on screen: this one sentence is what they hear, the voice saying how it went and whether they are needed.",
	},
};

const LENGTH: Record<BriefSurface, Record<Attention, string>> = {
	phone: { "eyes-busy": "At most 2 short sentences, about 30 words in total.", glance: "At most 3 short sentences, about 50 words in total." },
	terminal: {
		"eyes-busy": "At most 3 short sentences, about 45 words in total.",
		glance: "Exactly one sentence, about 15 words: the outcome, or the question they need to answer.",
	},
};

export const BRIEF_SYSTEM = (mode: Attention, surface: BriefSurface = "phone") => `You turn a coding agent's report into what a voice assistant says aloud to the developer. ${AUDIENCE[surface][mode]} The full written report stays in their transcript for later.

Talk the way two engineers talk on a walk: about behaviour, design, decisions, risks and what is left, not about code. Say what the work does or changes for the system or its users ("login now rejects expired tokens"), not which functions, files, variables, commands or tools were involved.

Rules for the spoken brief:
- Lead with the outcome: done, partly done, blocked, failed, or a decision they need to make.
- A caveat that changes what they should do next (something irreversible, a risk to production, data or security, an assumption the work rests on) is always said, even past the length limit below; it never goes into MORE.
- ${LENGTH[surface][mode]} One idea per sentence. Plain spoken language; contractions are fine.
- No identifiers, file names, paths, commands, test names, tool names, code, symbols, URLs or markdown. Name a part of the system by what it is ("the authentication module", "the phone app"). Round numbers.
- Tool activity is not news. Mention it only when it matters: a significant action (production, data, deployment, pushing, deleting, external services, money) or a failure that changes the outcome.
- If the agent asks the developer something, end with that question, answerable with yes, no or a short phrase, with at most two options. If it is a design decision, give the trade-off in a few words.
- Never pad: no greetings, no "the agent", no restating the request, no "let me know". Do not invent anything the report does not say.
${mode === "eyes-busy" ? "- Anything that needs visual review (a diff, a UI) waits until they are at a screen; say so in a few words.\n" : ""}
Then, only if there is meaningful detail they might want, add a line "MORE:" with up to two short topics they could ask about, phrased at the same level, e.g. "MORE: why the tests still fail; the alternative design".`;

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
export async function brief(
	d: RunDigest,
	mode: Attention,
	complete?: Complete,
	signal?: AbortSignal,
	surface: BriefSurface = "phone",
): Promise<Brief & { by: "model" | "heuristic" }> {
	if (complete) {
		try {
			const b = parseBrief(await complete(BRIEF_SYSTEM(mode, surface), digestText(d), { signal, maxTokens: 400 }));
			if (b.speech) return { ...b, by: "model" };
		} catch (e) {
			if (signal?.aborted) throw e;
		}
	}
	return { ...heuristicBrief(d, mode, surface), by: "heuristic" };
}

export function heuristicBrief(d: RunDigest, mode: Attention, surface: BriefSurface = "phone"): Brief {
	const parts: string[] = [];
	if (d.aborted) parts.push("Stopped.");
	const failed = d.commands.filter((c) => !c.ok);
	// The terminal at the desk says one sentence; everything else is on the screen.
	const sentences = surface === "terminal" ? (mode === "eyes-busy" ? 2 : 1) : mode === "eyes-busy" ? 1 : 2;
	const first = firstSentences(speakable(d.final), sentences);
	if (first) parts.push(first);
	else if (d.edits.length) parts.push(`Changed ${countWord(d.edits.length, "file")}.`);
	if (failed.length && !/fail|error/i.test(first)) parts.push(`${countWord(failed.length, "command")} failed.`);
	const question = lastQuestion(d.final);
	if (question && !parts.join(" ").includes(question)) {
		// One sentence at the desk: the question pi needs answered beats the outcome.
		if (surface === "terminal" && mode !== "eyes-busy") parts.length = 0;
		parts.push(question);
	}
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

/**
 * A running tool as a spoken activity, by category and never by name or path: "running the tests",
 * "changing code". Significant commands say what kind they are ("a database command").
 */
export function describeActivity(name: string, title: string): string {
	const t = title.trim();
	if (/^(bash|shell|exec|run)/i.test(name)) {
		if (isSignificant(t)) return `running ${significantKind(t)}`;
		if (/\b(test|tests|jest|vitest|pytest|mocha|playwright|cargo test|go test)\b/i.test(t)) return "running the tests";
		if (/\b(build|tsc|typecheck|compile|webpack|vite build|cargo build|make)\b/i.test(t)) return "building";
		if (/\b(lint|eslint|biome|ruff|prettier|fmt|clippy)\b/i.test(t)) return "checking the code style";
		if (/\b(install|npm ci|pip|uv sync|bundle|cargo add)\b/i.test(t)) return "installing dependencies";
		if (/^git\b/.test(t)) return "looking at version history";
		if (/\b(rg|grep|find|ls|cat|sed|head|tail)\b/.test(t)) return "looking through the code";
		return "running a command";
	}
	if (/edit|write|patch/i.test(name)) return "changing code";
	if (/read/i.test(name)) return "reading code";
	if (/grep|search|find|glob/i.test(name)) return "searching the code";
	if (/web|fetch/i.test(name)) return "researching on the web";
	if (/spawn|agent|task/i.test(name)) return "working with a helper agent";
	return "working";
}

export function significantKind(text: string): string {
	const t = text.toLowerCase();
	if (/\b(psql|mysql|mongo|redis-cli|database_url|drop|truncate|delete from|update \w+ set)\b/.test(t)) return /\bprod/.test(t) ? "a production database command" : "a database command";
	if (/\b(deploy|release|publish|docker push|npm publish)/.test(t)) return "a deployment";
	if (/git\s+push|--force|reset\s+--hard/.test(t)) return "a change to shared version history";
	if (/\b(kubectl|helm|terraform|tofu)\b/.test(t)) return "an infrastructure change";
	if (/\b(aws|gcloud|az)\s/.test(t)) return "a cloud command";
	if (/\b(ssh|scp)\s/.test(t)) return "a command on another machine";
	if (/rm\s+-\w*r/.test(t)) return "a deletion";
	if (/\bprod/.test(t)) return "a production command";
	return "a command that needs care";
}

export function firstSentences(text: string, n: number): string {
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

/** Appended to the agent's system prompt while the developer uses voice mode in this terminal (`/voice`). */
export function terminalVoiceNote(mode: Attention): string {
	return `

# Voice session
The user is talking to this session by voice through headphones at this computer${
		mode === "eyes-busy" ? " and cannot look at the screen right now" : "; they read your replies on screen as usual"
	}. A separate voice layer says one spoken sentence about each of your replies.
- Messages they spoke are speech transcripts, so expect recognition errors; typed parts are exact. They talk about intent and behaviour: map what they describe onto the code yourself.
- Start your final message with the outcome in one plain sentence (what now works, what changed, what is left), then details as usual. When you need a decision, end with one question answerable with yes, no or a short phrase.
- Before anything irreversible or outward-facing (production systems or data, deploying, pushing, deleting, force operations, sending messages, spending money), stop and ask for explicit confirmation that names the action.`;
}

/** Appended to the agent's system prompt while someone follows the session by voice. */
export function agentVoiceNote(mode: Attention): string {
	return `

# Voice session
The user is following this session by voice through their phone${
		mode === "eyes-busy" ? " and cannot look at a screen (they may be driving, running, cycling or cooking)" : ""
	}. A separate voice layer reads them a short spoken summary of each of your replies.
- They talk about intent, behaviour, architecture and trade-offs, not identifiers: map what they describe onto the code yourself. Their messages are speech transcripts, so expect recognition errors. If a request is genuinely ambiguous in a way that matters, ask one short question rather than guessing on anything risky.
- Start your final message with the outcome in one plain sentence, at the level of behaviour and design (what now works, what changed for users or the system, what is left), then details. When you need a decision, end with one question answerable with yes, no or a short phrase, with at most two options and the trade-off in a few words.
- Do not ask them to read code, diffs or long output now; ${
		mode === "eyes-busy" ? "leave visual review for when they are back at a screen and say so." : "keep anything they must review short."
	}
- Before anything irreversible or outward-facing (production systems or data, deploying, pushing, deleting, force operations, sending messages, spending money), stop and ask for explicit confirmation that names the action.`;
}
