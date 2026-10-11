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
	/** Declared names in the code (functions, classes, types, constants), bounded. */
	symbols?: string[];
	/** Corrections the developer made to earlier dictations ("get user" → `fetchUser`). */
	learned?: { from: string; to: string }[];
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

const cache = new Map<string, { at: number; files: string[]; branch?: string; symbols: string[] }>();

// Declarations across common languages: function/class/type/const names, Python defs, Rust/Go fns.
const DECL =
	"(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|module|object)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]{2,}";

/** Declared symbol names in tracked files, most frequent first, at most `max`. */
export function parseSymbols(grepOutput: string, max = 3000): string[] {
	const counts = new Map<string, number>();
	for (const line of grepOutput.split("\n")) {
		const name = line.trim().split(/\s+/)[1];
		if (!name || name.length < 4 || /^(this|self|true|false|null|undefined|async|await|return|export|default)$/.test(name)) continue;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	// Compound names (getUserById, parse_config) are what speech mangles and people name aloud;
	// short single words are mostly locals.
	const weight = (n: string, c: number) => c * (spokenWords(n, false).length > 1 ? 4 : n.length >= 7 ? 1 : 0.25);
	return [...counts]
		.sort((a, b) => weight(b[0], b[1]) - weight(a[0], a[1]))
		.slice(0, max)
		.map(([n]) => n);
}

/** Tracked files, branch and declared symbols of the git repo at `cwd` (cached for a minute). Empty outside git. */
export async function repoInfo(cwd: string, maxFiles = 5000): Promise<{ files: string[]; branch?: string; symbols: string[] }> {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < 60_000) return hit;
	const opts = { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 4000 };
	const [files, branch, symbols] = await Promise.all([
		run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], opts).then(
			(r) => r.stdout.split("\n").filter(Boolean).slice(0, maxFiles),
			() => [] as string[],
		),
		run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).then(
			(r) => r.stdout.trim() || undefined,
			() => undefined,
		),
		// Exit code 1 means no match; a huge repo is cut off by maxBuffer/timeout, which is fine.
		run("git", ["grep", "-h", "-I", "-o", "-E", "--untracked", DECL], { ...opts, maxBuffer: 16 * 1024 * 1024 }).then(
			(r) => parseSymbols(r.stdout),
			(e) => (typeof e?.stdout === "string" ? parseSymbols(e.stdout) : []),
		),
	]);
	const info = { at: Date.now(), files, branch: branch === "HEAD" ? undefined : branch, symbols };
	cache.set(cwd, info);
	return info;
}

export async function gatherVocabulary(cwd: string, branch: readonly any[], learned: { from: string; to: string }[] = []): Promise<Vocabulary> {
	const repo = await repoInfo(cwd);
	return { project: basename(cwd), branch: repo.branch, files: repo.files, recent: recentNames(branch), symbols: repo.symbols, learned };
}

/** Short recogniser hints (Apple contextual strings, transcription prompts): the most likely spoken names. */
export function recognizerHints(v: Vocabulary, limit = 100): string[] {
	const out = new Set<string>();
	const add = (s: string | undefined) => {
		if (s && s.length >= 3 && s.length <= 60 && out.size < limit) out.add(s);
	};
	add(v.project);
	for (const c of v.learned ?? []) add(c.to.replace(/`/g, ""));
	for (const w of v.branch?.split(/[/_.-]+/) ?? []) if (w.length > 3) add(w);
	for (const r of v.recent) add(r.includes("/") ? basename(r) : r);
	for (const s of (v.symbols ?? []).slice(0, 30)) add(s);
	const dirs = new Map<string, number>();
	for (const f of v.files) for (const d of f.split("/").slice(0, -1)) dirs.set(d, (dirs.get(d) ?? 0) + 1);
	for (const [d] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 20)) add(d);
	for (const f of v.files) add(basename(f));
	return [...out];
}

/** Edit distance, or `max + 1` as soon as it must exceed `max`. */
function lev(a: string, b: string, max = Infinity): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const prev = new Int32Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		let rowMin = prev[0];
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			const v = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (ca === b.charCodeAt(j - 1) ? 0 : 1));
			prev[j] = v;
			if (v < rowMin) rowMin = v;
			diag = tmp;
		}
		if (rowMin > max) return max + 1;
	}
	return prev[b.length];
}

const MAX_FUZZY_FILES = 2000;

/** Files worth fuzzy-matching, at most `max`: near what the conversation mentions, then shallow paths. */
export function salientFiles(v: Vocabulary, max = MAX_FUZZY_FILES): string[] {
	if (v.files.length <= max) return v.files;
	const dirs = new Set(v.recent.filter((r) => r.includes("/")).map((r) => r.split("/").slice(0, -1).join("/")));
	const mentioned = new Set(v.recent.map((r) => basename(r)));
	const rank = (f: string) => (mentioned.has(basename(f)) ? 0 : dirs.has(f.split("/").slice(0, -1).join("/")) ? 1 : 2 + f.split("/").length);
	return v.files
		.map((f, i) => ({ f, r: rank(f), i }))
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.slice(0, max)
		.map((x) => x.f);
}

function trigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
	return out;
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
export function matchNames(transcript: string, v: Vocabulary, limit = 40, minScore = 0.66): NameMatch[] {
	const words = norm(transcript).split(" ").filter(Boolean);
	if (!words.length) return [];
	const candidates = new Map<string, string>();
	for (const r of v.recent) candidates.set(r, r);
	for (const s of (v.symbols ?? []).slice(0, 2000)) if (!candidates.has(s)) candidates.set(s, s);
	for (const f of salientFiles(v)) {
		if (!candidates.has(basename(f))) candidates.set(basename(f), f);
		const stem = basename(f).replace(/\.[^.]+$/, "");
		if (stem.length >= 4 && !candidates.has(stem)) candidates.set(stem, f);
	}
	// Spoken forms, indexed by letter trigrams so each transcript window is compared only with forms
	// that share enough of its sound.
	const forms: { form: string; key: string; target: string; tris: number }[] = [];
	const index = new Map<string, number[]>();
	for (const [key, target] of candidates) {
		for (const form of new Set([spokenWords(key).join(""), spokenWords(key, false).join("")])) {
			if (form.length < 4) continue;
			const tris = trigrams(form);
			const id = forms.push({ form, key, target, tris: tris.size }) - 1;
			for (const t of tris) {
				const list = index.get(t);
				if (list) list.push(id);
				else index.set(t, [id]);
			}
		}
	}
	const best = new Map<string, NameMatch>();
	const counts = new Int32Array(forms.length);
	const touched: number[] = [];
	const seenWindows = new Set<string>();
	for (let i = 0; i < words.length; i++)
		for (let n = 1; n <= 6 && i + n <= words.length; n++) {
			const text = words.slice(i, i + n).join(" ");
			const letters = text.replace(/ /g, "");
			if (letters.length < 4 || seenWindows.has(letters)) continue;
			seenWindows.add(letters);
			const wt = trigrams(letters);
			touched.length = 0;
			for (const t of wt) {
				const list = index.get(t);
				if (!list) continue;
				for (const id of list) if (counts[id]++ === 0) touched.push(id);
			}
			for (const id of touched) {
				const shared = counts[id];
				counts[id] = 0;
				const f = forms[id];
				if (shared < Math.max(1, Math.min(f.tris, wt.size) * (minScore < 0.66 ? 0.2 : 0.3))) continue;
				if (Math.abs(letters.length - f.form.length) > Math.max(2, f.form.length * 0.4)) continue;
				const longest = Math.max(f.form.length, letters.length);
				const score = 1 - lev(letters, f.form, Math.floor(longest * (1 - minScore))) / longest;
				if (score < minScore) continue;
				const prev = best.get(f.target);
				if (!prev || score > prev.score) best.set(f.target, { name: f.target, heard: text, score });
			}
		}
	return [...best.values()].sort((a, b) => b.score - a.score || b.heard.length - a.heard.length).slice(0, limit);
}
