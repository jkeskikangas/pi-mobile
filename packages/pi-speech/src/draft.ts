// A long dictation becomes a draft: a Markdown document made of blocks (section headings, points,
// paragraphs, code fences) with stable ids. The drafting model never rewrites it; it returns section
// edits (add, change, move, remove a point; add a section; resolve an open question) that are applied
// here deterministically, so exactly the changed blocks glow and nothing else moves. A block may span
// lines (a paragraph with soft breaks, a list item with continuation lines, a fenced code block), so
// typed or pasted Markdown round-trips exactly (markdownBlocks, Draft.fromMarkdown, setMarkdown).

export type BlockKind = "heading" | "para" | "item";

export interface Block {
	id: number;
	kind: BlockKind;
	/** Markdown source of this one block, e.g. "## Goal", "- point", "1. question"; may span lines (a paragraph, a fence). */
	src: string;
	/**
	 * Typed text's own spacing: true for a blank line before this block, false for none. Unset: the
	 * default (a blank line, except between consecutive list items).
	 */
	gap?: boolean;
	/** When dictation (a model edit) last changed it. Never set by typing. */
	changedAt?: number;
	/** When dictation removed it: shown dim and struck through for a moment, then pruned. */
	removedAt?: number;
	/** When the developer last typed in it: the model doesn't overwrite text typed after it was asked. */
	typedAt?: number;
}

export type Shape = "prompt" | "spec" | "design notes" | "task list" | "bug report";
export const SHAPES: Record<Shape, string[]> = {
	prompt: ["Goal", "Requirements"],
	spec: ["Goal", "Context", "Requirements"],
	"design notes": ["Context", "Ideas", "Decisions"],
	"task list": ["Tasks"],
	"bug report": ["Problem", "Steps", "Expected"],
};
export const OPEN_QUESTIONS = "Open questions";
export const ALSO_MENTIONED = "Also mentioned";
/** Sections written as a sentence or two rather than a list. */
const PROSE = new Set(["goal", "problem"]);

export type SectionEdit =
	| { op: "add"; section: string; text: string }
	| { op: "change"; id?: string; match?: string; text: string; note?: string }
	| { op: "move"; id?: string; match?: string; section: string }
	| { op: "remove"; id?: string; match?: string }
	| { op: "resolve"; id?: string; match?: string; section?: string; text?: string }
	| { op: "add_section"; section: string; points: string[] };

export interface DraftUpdate {
	edits: SectionEdit[];
	kind?: "request" | "description";
	shape?: Shape;
	shapeNamed?: boolean;
	title?: string;
	/** False when the model output couldn't be read at all. */
	ok: boolean;
}

/** The kind of a block from its (first line of) source. A fenced code block is a "para". */
export function kindOf(src: string): BlockKind {
	if (/^#{1,6}\s/.test(src)) return "heading";
	if (/^\s*([-*+]|\d+[.)])\s/.test(src)) return "item";
	return "para";
}

const headingName = (b: Block) => b.src.replace(/^#+\s*/, "").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The text of a point without its list marker. */
export const pointText = (src: string) => src.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").trim();

/** One line of plain point text: list markers, headings and line breaks from the model removed. */
function clean(text: unknown): string {
	return String(text ?? "")
		.replace(/\s*\n\s*/g, " ")
		.replace(/^\s*(?:#+\s+|[-*+•]\s+|\d+[.)]\s+|\[[ x]\]\s+)+/i, "")
		.trim();
}

/** "open questions", "Open Questions:" → "Open questions"; other names keep their words, first letter capitalised. */
export function sectionName(name: unknown): string {
	const s = clean(name).replace(/[:#*]+$/g, "").trim();
	const known = [OPEN_QUESTIONS, ALSO_MENTIONED, ...Object.values(SHAPES).flat()].find((k) => norm(k) === norm(s));
	if (known) return known;
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

export function shapeOf(s: unknown): Shape | undefined {
	const n = norm(String(s ?? ""));
	if (!n) return undefined;
	if (/^spec/.test(n)) return "spec";
	if (/design/.test(n)) return "design notes";
	if (/task|todo|to do/.test(n)) return "task list";
	if (/bug|issue/.test(n)) return "bug report";
	if (/prompt|request/.test(n)) return "prompt";
	return undefined;
}

/** A shape the speaker named out loud ("make this a spec", "this is a task list"), or undefined. */
export function namedShape(speech: string): Shape | undefined {
	const m =
		/\b(?:make|turn|write|format)\s+(?:this|it|that|the draft)\s+(?:into\s+|as\s+)?(?:a\s+|an\s+|some\s+)?(speck?|specification|task list|to-?do list|list of tasks|prompt|design notes?|design doc(?:ument)?|bug report)\b/i.exec(speech) ??
		/\b(?:this|it)(?:'s| is)\s+(?:a|an|going to be a|gonna be a)\s+(speck?|specification|task list|to-?do list|design notes?|design doc(?:ument)?|bug report)\b/i.exec(speech);
	return m ? shapeOf(m[1]) : undefined;
}

/** Parses the drafting model's JSON, tolerating code fences, prose around it, trailing commas and op aliases. */
export function parseUpdate(out: string): DraftUpdate {
	const obj = looseJson(out);
	if (obj === undefined) return { edits: [], ok: false };
	const raw: unknown[] = Array.isArray(obj) ? obj : Array.isArray((obj as any)?.edits) ? (obj as any).edits : [];
	const edits = raw.map(toEdit).filter((e): e is SectionEdit => !!e);
	const o: any = Array.isArray(obj) ? {} : obj;
	const kind = o.kind === "request" || o.kind === "description" ? o.kind : undefined;
	const title = typeof o.title === "string" && o.title.trim() ? clean(o.title).slice(0, 80) : undefined;
	return { edits, kind, shape: shapeOf(o.shape), shapeNamed: o.shapeNamed === true, title, ok: true };
}

function looseJson(out: string): unknown {
	const text = String(out ?? "").replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1");
	const tries: string[] = [];
	const a = text.indexOf("{");
	const b = text.lastIndexOf("}");
	if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
	const c = text.indexOf("[");
	const d = text.lastIndexOf("]");
	if (c >= 0 && d > c && (a < 0 || c < a)) tries.unshift(text.slice(c, d + 1));
	for (const t of tries) {
		for (const s of [t, t.replace(/,\s*([}\]])/g, "$1")]) {
			try {
				return JSON.parse(s);
			} catch {}
		}
	}
	return undefined;
}

const OPS: Record<string, SectionEdit["op"]> = {
	add: "add",
	add_point: "add",
	insert: "add",
	change: "change",
	change_point: "change",
	update: "change",
	edit: "change",
	replace: "change",
	move: "move",
	move_point: "move",
	remove: "remove",
	remove_point: "remove",
	delete: "remove",
	drop: "remove",
	resolve: "resolve",
	resolve_question: "resolve",
	answer: "resolve",
	add_section: "add_section",
	addsection: "add_section",
	section: "add_section",
};

function toEdit(e: any): SectionEdit | undefined {
	if (!e || typeof e !== "object") return undefined;
	const op = OPS[String(e.op ?? e.type ?? e.action ?? "").toLowerCase().replace(/[\s-]+/g, "_")];
	const id = e.id === undefined || e.id === null ? undefined : String(e.id);
	const match = typeof e.match === "string" && e.match.trim() ? e.match.trim() : undefined;
	const text = clean(e.text ?? e.point ?? e.answer);
	const section = sectionName(e.section ?? e.to ?? e.heading);
	switch (op) {
		case "add":
			return text && section ? { op, section, text } : undefined;
		case "change":
			return text && (id || match) ? { op, id, match, text, note: e.note ? clean(e.note) : undefined } : undefined;
		case "move":
			return section && (id || match) ? { op, id, match, section } : undefined;
		case "remove":
			return id || match ? { op, id, match } : undefined;
		case "resolve":
			return id || match ? { op, id, match, section: section || undefined, text: text || undefined } : undefined;
		case "add_section": {
			const points = (Array.isArray(e.points) ? e.points : Array.isArray(e.items) ? e.items : []).map(clean).filter(Boolean);
			return section ? { op, section, points } : undefined;
		}
	}
	return undefined;
}

export interface ApplyOptions {
	/** Blocks the model may not change or remove (e.g. typed in after it was asked). */
	protect?: (b: Block) => boolean;
}

export class Draft {
	blocks: Block[] = [];
	title = "";
	shape: Shape = "prompt";
	/** The speaker named the shape: later guesses don't change it. */
	shapeNamed = false;
	private next = 1;

	/** A draft from Markdown, blocks split as markdownBlocks does; spacing normalised (see fromMarkdown). */
	constructor(markdown = "") {
		for (const p of markdownBlocks(markdown)) this.blocks.push(this.block(p.src));
	}

	/** A draft from typed Markdown that keeps its spacing: `fromMarkdown(md).markdown()` is `md` (blank lines collapsed, ends trimmed). */
	static fromMarkdown(markdown: string): Draft {
		const d = new Draft();
		for (const p of markdownBlocks(markdown)) {
			const b = d.block(p.src);
			setGap(d.blocks[d.blocks.length - 1], b, p.gap);
			d.blocks.push(b);
		}
		return d;
	}

	block(src: string): Block {
		return { id: this.next++, kind: kindOf(src), src };
	}

	live(): Block[] {
		return this.blocks.filter((b) => b.removedAt === undefined);
	}

	get empty(): boolean {
		return !this.live().some((b) => b.kind !== "heading" && b.src.trim());
	}

	/** The document as Markdown: a blank line between blocks, except between consecutive list items (or as typed). */
	markdown(): string {
		const out: string[] = [];
		let prev: Block | undefined;
		for (const b of this.live()) {
			// An empty line the developer opened and left empty is nothing.
			if (!b.src.trim()) continue;
			if (prev && gapBefore(prev, b)) out.push("");
			out.push(b.src);
			prev = b;
		}
		return out.join("\n");
	}

	/** The draft for the model: each point labelled with its id, e.g. "[p4] - Retry uploads". */
	forModel(): string {
		const live = this.live();
		if (!live.length) return "(empty)";
		return live.map((b) => (b.kind === "heading" ? `\n${b.src}` : `[p${b.id}] ${b.src}`)).join("\n").trim();
	}

	/** Live sections in order; points before the first heading belong to the section named "". */
	sections(): { name: string; heading?: Block; points: Block[] }[] {
		const out: { name: string; heading?: Block; points: Block[] }[] = [];
		for (const b of this.live()) {
			if (b.kind === "heading") out.push({ name: headingName(b), heading: b, points: [] });
			else {
				if (!out.length) out.push({ name: "", points: [] });
				out[out.length - 1]!.points.push(b);
			}
		}
		return out;
	}

	sectionOf(block: Block): string {
		let name = "";
		for (const b of this.live()) {
			if (b.kind === "heading") name = headingName(b);
			if (b === block) return name;
		}
		return name;
	}

	find(id: string | undefined, match?: string): Block | undefined {
		const live = this.live().filter((b) => b.kind !== "heading");
		const n = id === undefined ? NaN : Number(String(id).replace(/^\[?[a-z]*/i, "").replace(/\]$/, ""));
		const byId = Number.isFinite(n) ? live.find((b) => b.id === n) : undefined;
		if (byId) return byId;
		const m = norm(match ?? "");
		return m ? live.find((b) => norm(pointText(b.src)).includes(m)) : undefined;
	}

	/** Applies section edits as given; returns the ids of the blocks that changed (for the glow). */
	apply(update: Pick<DraftUpdate, "edits"> & Partial<DraftUpdate>, now: number, opts: ApplyOptions = {}): number[] {
		// The structure stays stable while you watch: the model's guess sets the shape of an empty draft
		// only; after that the shape changes only when the speaker names one.
		if (update.shape && (update.shapeNamed || (!this.shapeNamed && this.empty))) this.shape = update.shape;
		if (update.shapeNamed && update.shape) this.shapeNamed = true;
		if (update.title && !this.title) this.title = update.title;
		const changed = new Set<number>();
		const touch = (b: Block) => {
			b.changedAt = now;
			changed.add(b.id);
		};
		const editable = (b: Block | undefined): b is Block => !!b && !opts.protect?.(b);
		const had = new Set(this.blocks.map((b) => b.id));
		for (const e of update.edits) {
			switch (e.op) {
				case "add": {
					const b = this.addPoint(e.section, e.text, opts.protect);
					if (b) touch(b);
					break;
				}
				case "add_section": {
					const h = this.ensureSection(e.section);
					if (h.created) touch(h.heading);
					for (const p of e.points) {
						const b = this.addPoint(e.section, p, opts.protect);
						if (b) touch(b);
					}
					break;
				}
				case "change": {
					const b = this.find(e.id, e.match);
					if (!editable(b)) break;
					const text = e.note && !e.text.includes(e.note) ? `${e.text} *(${e.note.replace(/^\(|\)$/g, "")})*` : e.text;
					const src = this.format(this.sectionOf(b), text, b);
					if (src === b.src) break;
					b.src = src;
					b.kind = kindOf(src);
					touch(b);
					break;
				}
				case "move": {
					const b = this.find(e.id, e.match);
					if (!editable(b) || norm(this.sectionOf(b)) === norm(e.section)) break;
					this.blocks.splice(this.blocks.indexOf(b), 1);
					const { heading } = this.ensureSection(e.section);
					b.src = this.format(e.section, pointText(b.src));
					b.kind = kindOf(b.src);
					b.gap = undefined;
					this.blocks.splice(this.sectionEnd(heading), 0, b);
					touch(b);
					break;
				}
				case "remove": {
					const b = this.find(e.id, e.match);
					if (!editable(b)) break;
					b.removedAt = now;
					changed.add(b.id);
					break;
				}
				case "resolve": {
					const b = this.find(e.id, e.match);
					if (!editable(b)) break;
					b.removedAt = now;
					changed.add(b.id);
					if (e.text) {
						const into = e.section && norm(e.section) !== norm(OPEN_QUESTIONS) ? e.section : this.mainSections()[0]!;
						const a = this.addPoint(into, e.text, opts.protect);
						if (a) touch(a);
					}
					break;
				}
			}
		}
		// A new section's heading is part of the change; a section left without points goes too.
		for (const b of this.live()) if (b.kind === "heading" && !had.has(b.id)) touch(b);
		for (const s of this.sections()) {
			if (!s.heading || s.points.length) continue;
			s.heading.removedAt = now;
			changed.add(s.heading.id);
		}
		this.renumber();
		return [...changed];
	}

	/**
	 * The developer edited the whole draft as text (the phone's "Edit as text"): blocks whose source is
	 * unchanged keep their ids (and glow); the rest become typed blocks, which the model leaves alone.
	 * Struck-through blocks go. Afterwards `markdown()` returns `markdown` (blank lines collapsed, ends trimmed).
	 */
	setMarkdown(markdown: string, now: number): void {
		const pool = this.live().slice();
		const out: Block[] = [];
		for (const p of markdownBlocks(markdown)) {
			const i = pool.findIndex((b) => b.src === p.src);
			const b = i >= 0 ? pool.splice(i, 1)[0]! : this.block(p.src);
			if (i < 0) this.typed(b, p.src, now);
			setGap(out[out.length - 1], b, p.gap);
			out.push(b);
		}
		this.blocks = out;
	}

	/** The developer typed: never glows, and later model edits leave this block alone. */
	typed(b: Block, src: string, now: number): void {
		b.src = src;
		b.kind = kindOf(src);
		b.typedAt = now;
		b.changedAt = undefined;
	}

	/** Drops removed blocks once their strike-through has been shown long enough. */
	prune(now: number, ttl: number): boolean {
		const before = this.blocks.length;
		this.blocks = this.blocks.filter((b) => b.removedAt === undefined || now - b.removedAt < ttl);
		return this.blocks.length !== before;
	}

	mainSections(): string[] {
		return SHAPES[this.shape];
	}

	private rank(name: string): number {
		const n = norm(name);
		if (n === norm(ALSO_MENTIONED)) return 100;
		if (n === norm(OPEN_QUESTIONS)) return 90;
		if (PROSE.has(n)) return 0;
		// Context comes right after the goal in every shape that has one.
		if (n === "context") return 0.5;
		const i = this.mainSections().findIndex((s) => norm(s) === n);
		return i >= 0 ? i + 1 : 50;
	}

	private ensureSection(name: string): { heading: Block; created: boolean } {
		const s = this.sections().find((x) => x.heading && norm(x.name) === norm(name));
		if (s?.heading) return { heading: s.heading, created: false };
		const heading = this.block(`## ${sectionName(name)}`);
		// Existing sections never move: a new one goes before the first that ranks after it.
		const r = this.rank(name);
		const after = this.live().find((b) => b.kind === "heading" && this.rank(headingName(b)) > r);
		this.blocks.splice(after ? this.blocks.indexOf(after) : this.blocks.length, 0, heading);
		return { heading, created: true };
	}

	/** Index just after the last block of the heading's section. */
	private sectionEnd(heading: Block): number {
		let j = this.blocks.indexOf(heading) + 1;
		while (j < this.blocks.length && this.blocks[j]!.kind !== "heading") j++;
		return j;
	}

	private addPoint(section: string, text: string, protect?: (b: Block) => boolean): Block | undefined {
		const t = clean(text);
		if (!t) return undefined;
		const nt = norm(t);
		const words = (s: string) => s.split(" ").length;
		const existing = this.sections().find((s) => norm(s.name) === norm(section));
		for (const p of existing?.points ?? []) {
			const np = norm(pointText(p.src));
			// Already there, or a longer version of it is.
			if (np === nt || (words(nt) >= 3 && np.startsWith(nt))) return undefined;
			// A point cut off mid-sentence, now said in full: the full one replaces it.
			if (words(np) >= 3 && nt.startsWith(np) && !protect?.(p)) {
				p.src = this.format(section, t, p);
				p.kind = kindOf(p.src);
				return p;
			}
		}
		const { heading } = this.ensureSection(section);
		const b = this.block(this.format(section, t));
		this.blocks.splice(this.sectionEnd(heading), 0, b);
		return b;
	}

	/** Markdown for a point in a section: prose for Goal/Problem, numbered questions, bullets elsewhere. */
	private format(section: string, text: string, keep?: Block): string {
		const t = clean(text);
		const n = norm(section);
		if (PROSE.has(n)) return t;
		if (n === norm(OPEN_QUESTIONS)) return `1. ${t}`;
		const indent = keep ? (/^\s*/.exec(keep.src)?.[0] ?? "") : "";
		return `${indent}- ${t}`;
	}

	private renumber(): void {
		for (const s of this.sections()) {
			if (norm(s.name) !== norm(OPEN_QUESTIONS)) continue;
			let i = 1;
			for (const p of s.points) {
				if (!/^\d+[.)]\s/.test(p.src)) continue;
				p.src = p.src.replace(/^\d+/, String(i++));
			}
		}
	}
}

/** Blank line between blocks as Markdown renders the whole document; consecutive list items stay together. */
export function gapBefore(prev: Block, b: Block): boolean {
	return b.gap ?? defaultGap(prev, b);
}

const defaultGap = (prev: Pick<Block, "kind">, b: Pick<Block, "kind">) => !(prev.kind === "item" && b.kind === "item");

/** Records typed spacing (`gap`: a blank line before `b`) only where it differs from the default, so ordinary blocks stay ordinary. */
export function setGap(prev: Block | undefined, b: Block, gap: boolean): void {
	b.gap = prev && gap !== defaultGap(prev, b) ? gap : undefined;
}

/** The opening fence of a fenced code block (``` or ~~~, at least three), if `line` is one. */
export const fenceOf = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line)?.[1];

/** True when `src` is a fenced code block whose closing fence hasn't been written yet. */
export function openFence(src: string): boolean {
	const lines = src.split("\n");
	const f = fenceOf(lines[0] ?? "");
	if (!f) return false;
	return !lines.slice(1).some((l) => closes(f, l));
}

const closes = (fence: string, line: string) => {
	const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
	return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
};

/**
 * Markdown split into the draft's blocks, each line kept verbatim: a heading is one block; a paragraph
 * runs to the next blank line (its soft breaks stay inside it); a list item takes its continuation
 * lines; a fenced code block runs to its closing fence, blank lines and all. `gap`: a blank line came
 * before the block. Blank lines between blocks collapse to one; \r\n becomes \n.
 */
export function markdownBlocks(text: string): { src: string; gap: boolean }[] {
	const out: { src: string; gap: boolean }[] = [];
	let lines: string[] = [];
	let fence: string | undefined;
	let gap = false;
	let blank = false;
	const flush = () => {
		if (lines.length) out.push({ src: lines.join("\n"), gap });
		lines = [];
		fence = undefined;
	};
	const begin = (line: string) => {
		flush();
		gap = blank && out.length > 0;
		blank = false;
		lines = [line];
	};
	for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
		if (fence) {
			lines.push(line);
			if (closes(fence, line)) flush();
			continue;
		}
		if (!line.trim()) {
			flush();
			blank = true;
			continue;
		}
		const f = fenceOf(line);
		if (f) {
			begin(line);
			fence = f;
		} else if (kindOf(line) === "heading") {
			begin(line);
			flush();
		} else if (kindOf(line) === "item" || !lines.length) begin(line);
		else lines.push(line);
	}
	flush();
	return out;
}
