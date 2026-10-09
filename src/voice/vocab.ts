// Workspace vocabulary for voice: the names a developer is likely to say (files, identifiers,
// branch words), how they sound when spoken, and fuzzy matching of what the recogniser heard
// back to the real names ("get user by id" → getUserById, "orthodotts" → auth.ts).

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Vocabulary {
	/** Repository or folder name. */
	project: string;
	branch?: string;
	/** Tracked file paths (bounded). */
	files: string[];
	/** Identifiers and paths mentioned in the recent conversation, most recent first. */
	recent: string[];
}

const SYMBOLS: Record<string, string> = { ".": "dot", "/": "slash", _: "underscore", "-": "dash" };

/** Lowercase words a person says for a name: `getUserById` → ["get","user","by","id"], `auth.ts` → ["auth","dot","ts"]. */
export function spokenWords(name: string, withSymbols = true): string[] {
	const out: string[] = [];
	for (const part of name.split(/([./_-])/)) {
		if (!part) continue;
		if (SYMBOLS[part]) {
			if (withSymbols && part === ".") out.push(SYMBOLS[part]);
			continue;
		}
		for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)) if (w) out.push(w.toLowerCase());
	}
	return out;
}

/** How a name reads aloud: `getUserById` → "get user by id", `src/auth.ts` → "auth dot ts". */
export function sayName(name: string): string {
	const base = name.includes("/") ? basename(name) : name;
	return spokenWords(base).join(" ");
}

const IDENT = /`([^`\n]{2,80})`|\b([A-Za-z_$][\w$]*(?:[A-Z][\w$]*|_[\w$]+)+)\b|((?:[\w.-]+\/)*[\w-]+\.[A-Za-z]{1,6})\b/g;

/** Identifiers, paths and code spans in text, in order of appearance. */
export function extractNames(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(IDENT)) {
		const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (raw.length < 3 || raw.length > 80 || /\s{2,}/.test(raw)) continue;
		if (m[1] && /\s/.test(raw) && !/^[\w./-]+$/.test(raw.replace(/ /g, ""))) continue;
		if (/^\d|^https?:/.test(raw)) continue;
		out.push(raw);
	}
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: any) => (c?.type === "text" ? c.text : c?.type === "toolCall" ? JSON.stringify(c.arguments ?? {}) : ""))
		.join("\n");
}

/** Names from the last messages of the branch, most recent first, deduplicated. */
export function recentNames(branch: readonly any[], maxMessages = 30, limit = 300): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	let n = 0;
	for (let i = branch.length - 1; i >= 0 && n < maxMessages; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : undefined;
		if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
		n++;
		for (const name of extractNames(textOf(m.content))) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push(name);
			if (out.length >= limit) return out;
		}
	}
	return out;
}

const cache = new Map<string, { at: number; files: string[]; branch?: string }>();

/** Tracked files and branch of the git repo at `cwd` (cached for a minute). Empty outside git. */
export async function repoInfo(cwd: string, maxFiles = 5000): Promise<{ files: string[]; branch?: string }> {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < 60_000) return hit;
	const opts = { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 4000 };
	const [files, branch] = await Promise.all([
		run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], opts).then(
			(r) => r.stdout.split("\n").filter(Boolean).slice(0, maxFiles),
			() => [] as string[],
		),
		run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).then(
			(r) => r.stdout.trim() || undefined,
			() => undefined,
		),
	]);
	const info = { at: Date.now(), files, branch: branch === "HEAD" ? undefined : branch };
	cache.set(cwd, info);
	return info;
}

export async function gatherVocabulary(cwd: string, branch: readonly any[]): Promise<Vocabulary> {
	const repo = await repoInfo(cwd);
	return { project: basename(cwd), branch: repo.branch, files: repo.files, recent: recentNames(branch) };
}

/** Short recogniser hints (Apple contextual strings, transcription prompts): the most likely spoken names. */
export function recognizerHints(v: Vocabulary, limit = 100): string[] {
	const out = new Set<string>();
	const add = (s: string | undefined) => {
		if (s && s.length >= 3 && s.length <= 60 && out.size < limit) out.add(s);
	};
	add(v.project);
	for (const w of v.branch?.split(/[/_.-]+/) ?? []) if (w.length > 3) add(w);
	for (const r of v.recent) add(r.includes("/") ? basename(r) : r);
	const dirs = new Map<string, number>();
	for (const f of v.files) for (const d of f.split("/").slice(0, -1)) dirs.set(d, (dirs.get(d) ?? 0) + 1);
	for (const [d] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 20)) add(d);
	for (const f of v.files) add(basename(f));
	return [...out];
}

function lev(a: string, b: string): number {
	if (a === b) return 0;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

export interface NameMatch {
	/** The real name (identifier or path). */
	name: string;
	/** The words in the transcript that matched. */
	heard: string;
	/** 0..1, 1 = exact spoken form. */
	score: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Names from the vocabulary that the transcript probably said, best first. Compares spoken forms
 * with windows of transcript words, letters only, so recogniser splits and merges ("userbide",
 * "orthodotts") still match.
 */
export function matchNames(transcript: string, v: Vocabulary, limit = 40): NameMatch[] {
	const words = norm(transcript).split(" ").filter(Boolean);
	if (!words.length) return [];
	const candidates = new Map<string, string>();
	for (const r of v.recent) candidates.set(r, r);
	for (const f of v.files) {
		if (!candidates.has(basename(f))) candidates.set(basename(f), f);
		const stem = basename(f).replace(/\.[^.]+$/, "");
		if (stem.length >= 4 && !candidates.has(stem)) candidates.set(stem, f);
	}
	const windows: { text: string; letters: string }[] = [];
	for (let i = 0; i < words.length; i++)
		for (let n = 1; n <= 6 && i + n <= words.length; n++) {
			const text = words.slice(i, i + n).join(" ");
			windows.push({ text, letters: text.replace(/ /g, "") });
		}
	const best = new Map<string, NameMatch>();
	for (const [key, target] of candidates) {
		const forms = new Set([spokenWords(key).join(""), spokenWords(key, false).join("")]);
		for (const form of forms) {
			if (form.length < 4) continue;
			for (const w of windows) {
				if (Math.abs(w.letters.length - form.length) > Math.max(2, form.length * 0.4)) continue;
				const d = lev(w.letters, form);
				const score = 1 - d / Math.max(form.length, w.letters.length);
				if (score < 0.66) continue;
				const prev = best.get(target);
				if (!prev || score > prev.score) best.set(target, { name: target === key ? key : target, heard: w.text, score });
			}
		}
	}
	return [...best.values()].sort((a, b) => b.score - a.score || b.heard.length - a.heard.length).slice(0, limit);
}
