// A personal dictionary learned from your corrections: when you edit a distilled dictation before
// sending it, the words you replaced ("get user" → `fetchUser`) are remembered and applied next
// time, both as recogniser hints and in the distillation prompt.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Correction {
	from: string;
	to: string;
	count: number;
	at: number;
}

const MAX = 300;

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Worth learning: a code name, a path, or a proper name, not ordinary rewording. */
const nameLike = (s: string) => /[`/._]|[a-z][A-Z]|\d|\w-\w|^[A-Z][a-z]+[A-Z]/.test(s) || /^[A-Z][\w-]+$/.test(s.trim());

/**
 * Replaced spans between what was distilled and what was sent: token-level diff (LCS), keeping
 * replacements of 1–4 tokens by 1–4 tokens whose new text looks like a name.
 */
export function corrections(distilled: string, sent: string): { from: string; to: string }[] {
	const a = tokens(distilled);
	const b = tokens(sent);
	if (!a.length || !b.length || a.length * b.length > 250_000) return [];
	const n = a.length;
	const m = b.length;
	const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = bare(a[i]) === bare(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
	const out: { from: string; to: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && bare(a[i]) === bare(b[j])) {
			i++;
			j++;
			continue;
		}
		const i0 = i;
		const j0 = j;
		while ((i < n || j < m) && !(i < n && j < m && bare(a[i]) === bare(b[j]))) {
			if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) i++;
			else j++;
		}
		const from = a.slice(i0, i).join(" ").replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, "");
		const to = b.slice(j0, j).join(" ").replace(/^[^\p{L}\p{N}`/._]+|[.,;:!?]+$/gu, "");
		if (from && to && i - i0 <= 4 && j - j0 <= 4 && nameLike(to) && bare(from) !== bare(to)) out.push({ from, to });
	}
	return out;
}

export class Dictionary {
	private path: string;
	private write: (path: string, text: string) => void;

	constructor(stateDir: string, write: (path: string, text: string) => void) {
		this.path = join(stateDir, "voice-dictionary.json");
		this.write = write;
	}

	list(): Correction[] {
		try {
			const v = JSON.parse(readFileSync(this.path, "utf8"));
			return Array.isArray(v) ? v : [];
		} catch {
			return [];
		}
	}

	/** Learns from an edit; returns what was learned. */
	learn(distilled: string, sent: string, now = Date.now()): { from: string; to: string }[] {
		const found = corrections(distilled, sent);
		if (!found.length) return [];
		const all = this.list();
		for (const c of found) {
			const hit = all.find((x) => bare(x.from) === bare(c.from) && x.to === c.to);
			if (hit) {
				hit.count++;
				hit.at = now;
			} else all.push({ ...c, count: 1, at: now });
		}
		all.sort((x, y) => y.count - x.count || y.at - x.at);
		this.write(this.path, `${JSON.stringify(all.slice(0, MAX), null, 1)}\n`);
		return found;
	}

	/** The most used corrections, for prompts and recogniser hints. */
	top(n = 40): Correction[] {
		return this.list().slice(0, n);
	}
}
