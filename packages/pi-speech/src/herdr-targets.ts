// One voice, many sessions (designs/voice-modalities.md, "Behaviour of the voice itself" rule 4). The
// voice always runs in the local pi on the laptop, where the headphones are. Other sessions, in other
// herdr panes on this machine or on a saved SSH machine, are reached through herdr's CLI:
//
//   herdr [--machine <label>] agent list | get | prompt | wait | read | send-keys
//
// Everything here goes through one injectable runner (execFile with an argument list, never a shell),
// so the tests drive it with a fake herdr. pi-mobile's machine link is not used: the laptop is not a
// client of remote hubs. Off unless pi runs inside herdr and the herdr command works.
//
// The rules: a prompt is never retried blindly (a timeout does not prove nothing was sent; herdr's
// docs say read before retrying); a target waiting on a question gets no prompt, its question is read
// out instead; a question is answered with keys only when it is a select or yes/no dialog whose
// options and cursor are on screen, and only after checking it is still the same question.

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { VoicePrompt } from "./dialogs.ts";
import { digestText, firstSentences, type RunDigest, runDigest, speakable } from "./speech.ts";
import type { AnnounceKind } from "./voice-session.ts";

// ── the herdr command ──────────────────────────────────────────────────────────────────────────────

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The command did not finish in time (killed). */
	timedOut?: boolean;
	/** The herdr executable was not found. */
	missing?: boolean;
	/** Killed because the voice stopped (the signal). */
	aborted?: boolean;
}

/** Runs `herdr <args>`; never through a shell. The signal kills it (voice mode ended). */
export type HerdrExec = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<ExecResult>;

export function herdrExec(bin = process.env.PI_SPEECH_HERDR || "herdr", env: NodeJS.ProcessEnv = process.env): HerdrExec {
	return (args, timeoutMs, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) return resolve({ code: -1, stdout: "", stderr: "", aborted: true });
			execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env, windowsHide: true, signal }, (err: any, stdout, stderr) => {
				const out = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
				if (!err) return resolve({ code: 0, ...out });
				if (err.code === "ENOENT") return resolve({ code: -1, ...out, missing: true });
				if (err.name === "AbortError" || signal?.aborted) return resolve({ code: -1, ...out, aborted: true });
				if (err.killed) return resolve({ code: -1, ...out, timedOut: true });
				resolve({ code: typeof err.code === "number" ? err.code : 1, ...out });
			});
		});
}

export type HerdrErrorCode = "missing" | "timeout" | "stalled" | "blocked" | "not_found" | "unreachable" | "aborted" | "error";

export class HerdrError extends Error {
	code: HerdrErrorCode;
	constructor(code: HerdrErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgent {
	/** The saved machine's label; undefined for this computer. */
	machine?: string;
	/** The pane id hosting the agent (unique per server). */
	id: string;
	name?: string;
	/** pi, claude, codex, … */
	kind: string;
	status: AgentStatus;
	cwd: string;
	workspace?: string;
	tab?: string;
	title?: string;
	/** pi's session file, when herdr knows it (`agent_session.kind == "path"`). */
	sessionPath?: string;
	seq?: number;
	/** The pane this voice's own pi runs in. */
	self?: boolean;
}

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

function parseJson(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function toAgent(raw: any, machine?: string, labels: { ws?: Map<string, string>; tabs?: Map<string, string> } = {}): HerdrAgent | undefined {
	if (!raw || typeof raw !== "object" || typeof raw.pane_id !== "string") return undefined;
	const status = STATUSES.has(raw.agent_status) ? (raw.agent_status as AgentStatus) : "unknown";
	const tab = labels.tabs?.get(raw.tab_id);
	return {
		machine,
		id: raw.pane_id,
		name: typeof raw.name === "string" && raw.name ? raw.name : undefined,
		kind: String(raw.agent ?? "unknown"),
		status,
		cwd: String(raw.foreground_cwd ?? raw.cwd ?? ""),
		workspace: labels.ws?.get(raw.workspace_id),
		// Tabs are numbered "1", "2" unless someone named them.
		tab: tab && !/^\d+$/.test(tab) ? tab : undefined,
		title: typeof raw.terminal_title_stripped === "string" ? raw.terminal_title_stripped : undefined,
		sessionPath: raw.agent_session?.kind === "path" && typeof raw.agent_session.value === "string" ? raw.agent_session.value : undefined,
		seq: typeof raw.state_change_seq === "number" ? raw.state_change_seq : undefined,
	};
}

const baseName = (a: Pick<HerdrAgent, "name" | "cwd" | "workspace">) => a.name || basename(a.cwd || "") || a.workspace || "session";

/** How a session is named on the status line and in the transcript: "api", "api @devbox". */
export function agentLabel(a: Pick<HerdrAgent, "name" | "cwd" | "workspace" | "machine">): string {
	return a.machine ? `${baseName(a)} @${a.machine}` : baseName(a);
}

/** The same, for speech: "api on devbox", "claude in treat". */
export function spokenLabel(a: HerdrAgent): string {
	const where = a.machine ? ` on ${a.machine}` : "";
	return a.kind === "pi" ? `${baseName(a)}${where}` : `${a.kind} in ${baseName(a)}${where}`;
}

export const PROMPT_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 15_000;
export const LIST_TIMEOUT_MS = 12_000;
export const WAIT_CHUNK_MS = 60_000;

/** herdr's CLI, JSON in and out, errors classified. */
export class HerdrClient {
	exec: HerdrExec;
	private signal?: AbortSignal;
	constructor(exec: HerdrExec, signal?: AbortSignal) {
		this.exec = exec;
		this.signal = signal;
	}

	private async run(machine: string | undefined, args: string[], timeoutMs: number, json = true): Promise<any> {
		const full = machine ? ["--machine", machine, ...args] : args;
		if (this.signal?.aborted) throw new HerdrError("aborted", "voice mode ended");
		const r = await this.exec(full, timeoutMs + 2000, this.signal);
		if (r.aborted) throw new HerdrError("aborted", "voice mode ended");
		if (r.missing) throw new HerdrError("missing", "the herdr command is not installed");
		if (r.timedOut) throw new HerdrError("timeout", `herdr ${args.slice(0, 2).join(" ")} timed out`);
		if (r.code !== 0) {
			const e = parseJson(r.stderr.trim().split("\n").pop() ?? "")?.error ?? parseJson(r.stdout)?.error;
			const code = String(e?.code ?? "");
			const message = String(e?.message ?? (r.stderr.trim() || r.stdout.trim() || `herdr exited with ${r.code}`)).slice(0, 300);
			if (code === "timeout") throw new HerdrError("timeout", message);
			if (code === "agent_prompt_stalled") throw new HerdrError("stalled", message);
			if (code === "agent_blocked") throw new HerdrError("blocked", message);
			if (code === "agent_not_found" || code === "pane_not_found" || code === "agent_not_running") throw new HerdrError("not_found", message);
			// No structured error from a --machine command: the SSH hop or the remote server failed.
			if (machine && !code) throw new HerdrError("unreachable", `${machine} is unreachable: ${message}`);
			throw new HerdrError("error", message);
		}
		if (!json) return r.stdout;
		const j = parseJson(r.stdout);
		if (!j || typeof j !== "object") throw new HerdrError("error", `herdr ${args.slice(0, 2).join(" ")}: unreadable output`);
		return j.result ?? j;
	}

	/** Enabled saved machines, by label. */
	async machines(): Promise<string[]> {
		const r = await this.exec(["machine", "list", "--json"], LIST_TIMEOUT_MS, this.signal);
		if (r.missing) throw new HerdrError("missing", "the herdr command is not installed");
		const j = r.code === 0 ? parseJson(r.stdout) : undefined;
		const list = Array.isArray(j) ? j : Array.isArray(j?.machines) ? j.machines : [];
		return list.filter((m: any) => m && m.enabled !== false && typeof (m.label ?? m.id) === "string").map((m: any) => String(m.label ?? m.id));
	}

	/** Every agent on one server, with workspace and tab labels. */
	async agents(machine?: string): Promise<HerdrAgent[]> {
		const [list, ws, tabs] = await Promise.all([
			this.run(machine, ["agent", "list"], LIST_TIMEOUT_MS),
			this.run(machine, ["workspace", "list"], LIST_TIMEOUT_MS).catch(() => undefined),
			this.run(machine, ["tab", "list"], LIST_TIMEOUT_MS).catch(() => undefined),
		]);
		const labels = {
			ws: new Map<string, string>((Array.isArray(ws?.workspaces) ? ws.workspaces : []).map((w: any) => [w?.workspace_id, String(w?.label ?? "")])),
			tabs: new Map<string, string>((Array.isArray(tabs?.tabs) ? tabs.tabs : []).map((t: any) => [t?.tab_id, String(t?.label ?? "")])),
		};
		return (Array.isArray(list?.agents) ? list.agents : []).map((a: any) => toAgent(a, machine, labels)).filter((a: HerdrAgent | undefined): a is HerdrAgent => !!a);
	}

	private merge(t: HerdrAgent, raw: any): HerdrAgent {
		const a = toAgent(raw, t.machine);
		return a ? { ...t, ...a, name: a.name ?? t.name, workspace: t.workspace, tab: t.tab, self: t.self } : t;
	}

	async get(t: HerdrAgent): Promise<HerdrAgent> {
		const r = await this.run(t.machine, ["agent", "get", t.id], READ_TIMEOUT_MS);
		if (!toAgent(r?.agent, t.machine)) throw new HerdrError("error", "herdr agent get: unreadable output");
		return this.merge(t, r.agent);
	}

	/**
	 * Submits the text plus Enter. herdr rejects it (sending nothing) when the agent is blocked. The
	 * text goes verbatim: herdr 0.9.3 takes its second argument as the text even when it starts with
	 * "-" ("--" is not an end of options there: it would be sent as the text). Several lines go as one
	 * bracketed paste, then Enter, to an agent that turned bracketed paste on (pi does).
	 */
	async prompt(t: HerdrAgent, text: string): Promise<void> {
		await this.run(t.machine, ["agent", "prompt", t.id, text], PROMPT_TIMEOUT_MS);
	}

	/** Waits for one of the states; throws `timeout` when none came in time. */
	async wait(t: HerdrAgent, until: AgentStatus[], timeoutMs: number): Promise<HerdrAgent> {
		const args = ["agent", "wait", t.id, ...until.flatMap((u) => ["--until", u]), "--timeout", String(timeoutMs)];
		const r = await this.run(t.machine, args, timeoutMs + 3000);
		return this.merge(t, r?.agent);
	}

	async read(t: HerdrAgent, source: "visible" | "recent-unwrapped", lines: number): Promise<string> {
		return this.run(t.machine, ["agent", "read", t.id, "--source", source, "--lines", String(lines)], READ_TIMEOUT_MS, false);
	}

	async sendKeys(t: HerdrAgent, keys: string[]): Promise<void> {
		await this.run(t.machine, ["agent", "send-keys", t.id, ...keys], READ_TIMEOUT_MS);
	}
}

// ── naming a session ───────────────────────────────────────────────────────────────────────────────

const squash = (s: string) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter(Boolean);

const KINDS = new Set(["pi", "claude", "codex", "gemini", "cursor", "devin", "cline", "opencode", "copilot", "amp", "grok", "kimi", "kiro", "droid", "qwen"]);
const STOP = new Set(
	"switch talk go back move change to with the a an on in at for of from my me please session sessions agent agents one project workspace tab machine box computer server that over there lets let s i want".split(
		" ",
	),
);
/** "Back to this one", "this session", "here": the voice's own session. */
export const SELF =
	/^(?:(?:go |switch |talk |come |move )?(?:back )?(?:to )?(?:this|the local|my own|my|our|the original|the first) ?(?:one|session|pi|terminal|here)?|back|here|home|local|myself|me|this|go back|switch back|come back)$/;
const LOCAL_WORDS = new Set(["local", "laptop", "here", "mac"]);

export type Resolution =
	| { kind: "self" }
	| { kind: "agent"; agent: HerdrAgent }
	| { kind: "ambiguous"; options: HerdrAgent[] }
	| { kind: "none"; reason: string };

const FIELDS: ["name" | "cwdBase" | "workspace" | "tab" | "title", number][] = [
	["name", 5],
	["cwdBase", 4],
	["workspace", 4],
	["tab", 3],
	["title", 2],
];

/** 3: the field is the phrase; 2: contains it; 1.5: the phrase contains the field; 1: all its words are in the field. */
function fieldMatch(field: string | undefined, core: string[], strict = false): number {
	if (!field || !core.length) return 0;
	const f = squash(field);
	const c = core.join("");
	if (!f) return 0;
	if (f === c) return 3;
	if (c.length >= 3 && f.includes(c)) return 2;
	if (strict) return 0;
	if (f.length >= 3 && c.includes(f)) return 1.5;
	const fw = new Set(words(field));
	if (core.every((w) => fw.has(w))) return 1;
	return 0;
}

/**
 * How well an agent matches: the best match level over its names. An exact match is as good on any of
 * them (a folder called treat and an agent named treat are equally "treat": ambiguous); the field's
 * weight only breaks ties between partial matches.
 */
function score(a: HerdrAgent, core: string[], strict = false): number {
	let best = 0;
	for (const [k, w] of FIELDS) {
		const level = fieldMatch(k === "cwdBase" ? basename(a.cwd || "") : a[k], core, strict);
		if (level) best = Math.max(best, level >= 3 ? 30 : level * 10 + w);
	}
	return best;
}

/**
 * A spoken name to a session: agent name, workspace or tab label, the folder's name, the machine's
 * label ("the pi on devbox"), or this session ("back to this one"). Several equally good matches are
 * ambiguous: the voice asks which.
 */
export function resolveTarget(query: string, agents: HerdrAgent[], machines: string[] = []): Resolution {
	const raw = words(query).join(" ");
	if (!raw) return { kind: "none", reason: "no name given" };
	if (SELF.test(raw)) return { kind: "self" };
	let tokens = words(query);
	// The machine: a saved machine's label (possibly several words), or this computer.
	let machine: string | null | undefined;
	for (const m of [...machines].sort((x, y) => y.length - x.length)) {
		const n = words(m).length;
		for (let i = 0; n && i + n <= tokens.length; i++) {
			if (squash(tokens.slice(i, i + n).join("")) === squash(m)) {
				machine = m;
				tokens = [...tokens.slice(0, i), ...tokens.slice(i + n)];
				break;
			}
		}
		if (machine) break;
	}
	if (machine === undefined && tokens.length > 1 && tokens.some((t) => LOCAL_WORDS.has(t))) {
		machine = null;
		tokens = tokens.filter((t) => !LOCAL_WORDS.has(t));
	}
	const pool = agents.filter((a) => (machine === undefined ? true : machine === null ? !a.machine : a.machine === machine));
	if (!pool.length) return { kind: "none", reason: machine ? `no sessions on ${machine}` : "no other sessions" };
	const core = tokens.filter((t) => !STOP.has(t));
	const kindWords = core.filter((t) => KINDS.has(t));
	const named = core.filter((t) => !KINDS.has(t));
	const ofKind = (list: HerdrAgent[]) => {
		if (!kindWords.length) return list;
		const k = list.filter((a) => kindWords.includes(a.kind));
		return k.length ? k : list;
	};
	const pick = (list: HerdrAgent[]): Resolution => {
		const one = (a: HerdrAgent): Resolution => (a.self ? { kind: "self" } : { kind: "agent", agent: a });
		if (list.length === 1) return one(list[0]);
		// Several: a pi is the default kind of session to talk to.
		if (!kindWords.length) {
			const pis = list.filter((a) => a.kind === "pi");
			if (pis.length === 1) return one(pis[0]);
		}
		return { kind: "ambiguous", options: list };
	};
	// Only a machine (and maybe a kind): "the pi on devbox".
	if (!named.length && machine !== undefined) return pick(ofKind(pool));
	if (!core.length) return { kind: "none", reason: `no session called "${query}"` };
	const best = (list: HerdrAgent[], c: string[], strict: boolean) => {
		const scored = list.map((a) => ({ a, s: score(a, c, strict) })).filter((x) => x.s > 0);
		const top = Math.max(0, ...scored.map((x) => x.s));
		return scored.filter((x) => x.s === top).map((x) => x.a);
	};
	// A kind word may be part of a name ("pi mobile" is pi-mobile): the whole phrase first, as a name.
	if (kindWords.length && named.length) {
		const whole = best(pool, core, true);
		if (whole.length) return pick(whole);
	}
	// Otherwise the kind narrows the sessions ("the claude in treat") and the rest names one.
	const found = named.length ? best(ofKind(pool), named, false) : [];
	if (found.length) return pick(found);
	return { kind: "none", reason: `no session called "${query}"` };
}

/** "api on devbox (pi, working)": for asking which one. */
export function describeOption(a: HerdrAgent): string {
	const where = a.machine ? `on ${a.machine}` : "on this computer";
	const extra = [a.kind, a.status === "blocked" ? "waiting on a question" : a.status, a.workspace && a.workspace !== basename(a.cwd) ? `workspace ${a.workspace}` : ""]
		.filter(Boolean)
		.join(", ");
	return `${a.self ? "this session" : baseName(a)} ${where} (${extra})`;
}

// ── what everything is doing ───────────────────────────────────────────────────────────────────────

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number) => SMALL[n] ?? String(n);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function projects(list: HerdrAgent[]): string {
	const seen = new Map<string, number>();
	for (const a of list) {
		const k = `${basename(a.cwd || "") || a.name || a.workspace || "a session"}${a.machine ? ` on ${a.machine}` : ""}`;
		seen.set(k, (seen.get(k) ?? 0) + 1);
	}
	const parts = [...seen].map(([k, n]) => (n > 1 ? `${k} (${count(n)})` : k));
	if (parts.length > 4) return `${parts.slice(0, 3).join(", ")} and ${count(parts.length - 3)} more`;
	return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/**
 * "Anything need me?": the other sessions' states, by project, in one or two sentences. Blocked first
 * (they need you), then working, then finished and not yet looked at; idle ones are only counted.
 */
export function fleetSummary(agents: HerdrAgent[], unreachable: string[] = [], machine?: string): string {
	const list = agents.filter((a) => !a.self && (!machine || a.machine === machine));
	const blocked = list.filter((a) => a.status === "blocked");
	const working = list.filter((a) => a.status === "working");
	const done = list.filter((a) => a.status === "done");
	const idle = list.length - blocked.length - working.length - done.length;
	const gone = unreachable.filter((m) => !machine || m === machine);
	const first = blocked.length
		? `${blocked.length === 1 ? "One needs you" : `${cap(count(blocked.length))} need you`}: ${projects(blocked)}.`
		: list.length
			? "Nothing needs you."
			: gone.length
				? ""
				: machine
					? `No sessions on ${machine}.`
					: "There are no other sessions.";
	const rest: string[] = [];
	if (working.length) rest.push(`working: ${projects(working)}`);
	if (done.length) rest.push(`finished: ${projects(done)}`);
	if (idle > 0) rest.push(`${count(idle)} idle`);
	const second = rest.length ? `${cap(rest.join("; "))}.` : "";
	const third = gone.length ? `${gone.join(" and ")} didn't answer.` : "";
	return [first, second, third].filter(Boolean).join(" ");
}

// ── pi's questions on another screen ───────────────────────────────────────────────────────────────

export interface ScreenDialog {
	title: string;
	message?: string;
	options: string[];
	cursor: number;
	/** Identifies this exact question, to check it is still the one on screen before answering. */
	signature: string;
}

const SEPARATOR = (l: string) => (l.match(/[─━]/g)?.length ?? 0) >= 20;
const CURSOR = /^\s*(?:→|❯|›|▶|>)\s+(.*\S)\s*$/;
const HINT_LINE = /\b(?:navigate|enter (?:to )?select|esc(?:ape)?(?:\/ctrl\+c)? (?:to )?cancel)\b/i;

/**
 * A select or yes/no dialog as pi (and agents with the same arrow-key menus) draw it: a title, maybe a
 * message, then options, one of them marked with a cursor (→ ❯ ›). Anything else (free-text input, a
 * dialog without a visible cursor) is not mapped: it needs the screen.
 */
export function parseDialog(screen: string): ScreenDialog | undefined {
	let lines = String(screen ?? "").replace(/\r/g, "").split("\n");
	const seps = lines.map((l, i) => (SEPARATOR(l) ? i : -1)).filter((i) => i >= 0);
	if (seps.length >= 2) lines = lines.slice(seps[seps.length - 2] + 1, seps[seps.length - 1]);
	else if (seps.length === 1) lines = lines.slice(seps[0] + 1);
	const cur = lines.findIndex((l) => CURSOR.test(l) && !HINT_LINE.test(l));
	if (cur < 0) return undefined;
	// The option block: contiguous non-blank lines around the cursor line.
	let start = cur;
	while (start > 0 && lines[start - 1].trim() && !HINT_LINE.test(lines[start - 1])) start--;
	let end = cur;
	while (end + 1 < lines.length && lines[end + 1].trim() && !HINT_LINE.test(lines[end + 1])) end++;
	const block = lines.slice(start, end + 1);
	// A long option wrapped over two lines would read as two options, and the keys would pick the
	// wrong one: such a dialog needs the screen. Wrapped: a line reaching the screen's width (the rule
	// lines are full width), or numbered options with an unnumbered line among them.
	const width = Math.max(0, ...String(screen ?? "").replace(/\r/g, "").split("\n").filter(SEPARATOR).map((l) => l.trimEnd().length));
	if (width && block.some((l) => l.trimEnd().length >= width - 1)) return undefined;
	const numbered = block.map((l) => /^\d+[.)]\s+/.test((CURSOR.exec(l)?.[1] ?? l).trim()));
	if (numbered.some(Boolean) && !numbered.every(Boolean)) return undefined;
	const options = block.map((l) => (CURSOR.exec(l)?.[1] ?? l.trim()).replace(/^\d+[.)]\s+/, "").trim());
	if (options.length < 2 || options.some((o) => !o || o.length > 160)) return undefined;
	// The question: the paragraph right above the options (pi: the title, then the message).
	const head = lines.slice(0, start);
	let i = head.length - 1;
	while (i >= 0 && !head[i].trim()) i--;
	const para: string[] = [];
	while (i >= 0 && head[i].trim()) para.unshift(head[i--].trim());
	const [title, ...msg] = para.filter((l) => !HINT_LINE.test(l));
	if (!title) return undefined;
	const message = msg.join(" ") || undefined;
	return { title, message, options, cursor: cur - start, signature: squash(`${title}|${message ?? ""}|${options.join("|")}`) };
}

const isYesNo = (o: string[]) => o.length === 2 && /^yes\b/i.test(o[0]) && /^no\b/i.test(o[1]);

/** The dialog as a question the voice asks, with the target named. */
export function dialogPrompt(d: ScreenDialog, label: string, id: string): VoicePrompt {
	const title = `${label} asks: ${d.title}`;
	return isYesNo(d.options) ? { id, kind: "confirm", title, message: d.message } : { id, kind: "select", title, message: d.message, options: d.options };
}

/** The keys that give this answer: arrows from the cursor to the option, then Enter; Esc cancels. */
export function keysFor(d: ScreenDialog, value: unknown): string[] | undefined {
	if (value === undefined) return ["esc"];
	let target: number;
	if (typeof value === "boolean") {
		if (!isYesNo(d.options)) return undefined;
		target = value ? 0 : 1;
	} else target = d.options.indexOf(String(value));
	if (target < 0) return undefined;
	const moves = target - d.cursor;
	return [...Array<string>(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
}

// ── an answer on another screen ────────────────────────────────────────────────────────────────────

const TOOL_LINE = /[✓✗✔✘◌]\s*$/;
const TIMING_LINE = /^\s*\d+(?:\.\d+)?m?s\s+·\s/;
const SPINNER = /^[\s⠀-⣿·*✻✽✢]*(?:Working|Thinking|Esc to interrupt)\b/i;
const BORDER = /^[\s│╭╮╰╯─━┃]*$/;

/**
 * pi's answer from its screen: what follows the last echo of the request, up to the editor (the
 * second-to-last rule line), without tool lines, timings, spinners and borders. Best effort for other
 * agents' screens; a pi on this computer is read from its session file instead (`sessionDigest`).
 */
export function extractAnswer(screen: string, request = ""): string {
	let lines = String(screen ?? "").replace(/\r/g, "").split("\n");
	const seps = lines.map((l, i) => (SEPARATOR(l) ? i : -1)).filter((i) => i >= 0);
	if (seps.length >= 2) lines = lines.slice(0, seps[seps.length - 2]);
	else if (seps.length === 1) lines = lines.slice(0, seps[0]);
	const want = squash(request);
	if (want.length >= 4) {
		const key = want.slice(0, Math.min(24, want.length));
		let at = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			const l = squash(lines[i].replace(/^\s*(?:>|❯|›)\s*/, ""));
			if (l.length >= 4 && (l.startsWith(key) || key.startsWith(l))) {
				at = i;
				break;
			}
		}
		if (at >= 0) {
			// The echo may wrap over several lines.
			let acc = squash(lines[at]);
			let j = at + 1;
			while (j < lines.length && lines[j].trim() && want.includes(acc + squash(lines[j]))) acc += squash(lines[j++]);
			lines = lines.slice(j);
		}
	}
	return lines
		.filter((l) => !l.trim() || (!TOOL_LINE.test(l) && !TIMING_LINE.test(l) && !SPINNER.test(l) && !/^\s*⎿/.test(l) && !BORDER.test(l)))
		.map((l) => l.replace(/^\s*⏺\s?/, "").replace(/^\s*│\s?|\s?│\s*$/g, "").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** The active branch of a pi session file (JSON lines, a tree by parentId), oldest first. */
export function sessionBranch(jsonl: string): any[] {
	const entries: any[] = [];
	for (const line of String(jsonl ?? "").split("\n")) {
		if (!line.trim()) continue;
		const e = parseJson(line);
		if (e && typeof e === "object" && typeof e.id === "string" && e.type !== "session") entries.push(e);
	}
	if (!entries.length) return [];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch: any[] = [];
	const seen = new Set<string>();
	for (let e = entries.at(-1); e && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
		seen.add(e.id);
		branch.push(e);
	}
	return branch.reverse();
}

/** The latest run of a pi on this computer, from its session file: exact text, edits, commands. */
export function sessionDigest(jsonl: string, request = ""): RunDigest | undefined {
	const d = runDigest(sessionBranch(jsonl));
	if (!d.final && !d.errors.length) return undefined;
	// Not this request's run (the file lags behind the screen): read the screen instead.
	const want = squash(request).slice(0, 40);
	if (want && !squash(d.request).includes(want)) return undefined;
	return d;
}

const MAX_SESSION_BYTES = 8 * 1024 * 1024;

function readSession(path: string): string | undefined {
	try {
		if (statSync(path).size > MAX_SESSION_BYTES) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The written answer in the local transcript: compact, the detail stays on the other screen. */
export function compact(text: string, max = 1200): string {
	const t = String(text ?? "").trim();
	return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")} …` : t;
}

// ── the voice's side ───────────────────────────────────────────────────────────────────────────────

/** A line in the local transcript about another session (a custom entry: shown, never sent to the model). */
export interface RemoteEntry {
	/** sent: a request went there; answer: its answer; question: it asks something; note: anything else. */
	kind: "sent" | "answer" | "question" | "note";
	target: string;
	text: string;
	/** The spoken sentence (answers), unless Quiet. */
	said?: string;
}

export interface TargetPorts {
	exec: HerdrExec;
	/** pi runs inside herdr (HERDR_ENV=1). */
	inHerdr: boolean;
	/** The pane this pi runs in (HERDR_PANE_ID): "this session" in lists. */
	selfPane?: string;
	/** The one spoken sentence for a run (the brief writer). */
	brief(d: RunDigest): Promise<string>;
	/** A question read out and answerable by voice (VoiceSession.ask). */
	ask(prompt: VoicePrompt, answer: (v: unknown) => void): void;
	closePrompt(id: string): void;
	/** pi tells the developer something (VoiceSession.announce). */
	announce(kind: AnnounceKind, sentence: string, opts?: { context?: string }): void;
	show(entry: RemoteEntry): void;
	quiet(): boolean;
	onTarget?(target: HerdrAgent | undefined): void;
	readFile?(path: string): string | undefined;
	sleep?(ms: number): Promise<void>;
	now?(): number;
	log?(entry: Record<string, unknown>): void;
}

export const WATCH_MS = 30 * 60_000;
export const START_MS = 10_000;
const ANSWER_LINES = 200;

interface Watch {
	request: string;
	/** herdr's state counter when the request was sent: its answer is only after this moved. */
	beforeSeq?: number;
	startedAt: number;
	/** The request was seen running (working or blocked, or still busy at a wait's timeout). */
	started: boolean;
	/** Bumped when a newer request takes over the watch. */
	gen: number;
}

const keyOf = (t: HerdrAgent) => `${t.machine ?? ""}|${t.id}`;
const signatureOf = (screen: string) => parseDialog(screen)?.signature ?? `unmapped:${squash(screen.slice(-400))}`;

/**
 * The voice's other sessions: which one it talks to, sending it requests, following them to their
 * answer, their questions by voice, and what everything is doing.
 */
export class HerdrTargets {
	private p: TargetPorts;
	private client: HerdrClient;
	/** undefined: this session (the default). */
	current?: HerdrAgent;
	private cache?: { at: number; agents: HerdrAgent[]; machines: string[]; unreachable: string[] };
	private watches = new Map<string, Watch>();
	/** Open questions by target: the dialog's signature and the voice prompt's id. */
	private dialogs = new Map<string, { signature: string; id: string }>();
	private unavailableTold = false;
	private closed = false;
	/** Kills herdr commands still running (a 60 s agent wait) when the voice stops. */
	private abort = new AbortController();
	/** The latest answer from another session, for "tell me more". */
	last?: { label: string; text: string };

	constructor(ports: TargetPorts) {
		this.p = ports;
		this.client = new HerdrClient(ports.exec, this.abort.signal);
	}

	private now() {
		return this.p.now?.() ?? Date.now();
	}
	private sleep(ms: number) {
		return this.p.sleep ? this.p.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms).unref?.());
	}

	/** Following stops; open questions stay on their screens. */
	close(): void {
		this.closed = true;
		this.abort.abort();
		for (const d of this.dialogs.values()) this.p.closePrompt(d.id);
		this.dialogs.clear();
	}

	/** "api @devbox" for the status line; undefined while talking to this session. */
	label(): string | undefined {
		return this.current ? agentLabel(this.current) : undefined;
	}

	/** Why other sessions are unavailable: said once, then only that it isn't available. */
	private unavailable(reason: string): Record<string, unknown> {
		const told = this.unavailableTold;
		this.unavailableTold = true;
		return told
			? { error: "other sessions are unavailable (the developer was already told why): say only that it isn't available" }
			: { error: `other sessions are unavailable: ${reason}. Tell the developer once, in a few words.` };
	}

	private failure(e: any): Record<string, unknown> {
		const err = e instanceof HerdrError ? e : new HerdrError("error", String(e?.message ?? e));
		if (err.code === "missing") return this.unavailable(err.message);
		return { error: err.message };
	}

	/** Every agent on this computer and the saved machines; machines that fail are listed as unreachable. */
	async fleet(maxAgeMs = 3000): Promise<{ agents: HerdrAgent[]; machines: string[]; unreachable: string[] }> {
		if (!this.p.inHerdr) throw new HerdrError("missing", "pi is not running inside herdr");
		if (this.cache && this.now() - this.cache.at < maxAgeMs) return this.cache;
		const [local, machines] = await Promise.all([this.client.agents(), this.client.machines().catch(() => [] as string[])]);
		const unreachable: string[] = [];
		const remote = await Promise.all(
			machines.map((m) =>
				this.client.agents(m).catch((e) => {
					unreachable.push(m);
					this.p.log?.({ herdr: "unreachable", machine: m, error: String(e?.message ?? e) });
					return [] as HerdrAgent[];
				}),
			),
		);
		for (const a of local) if (this.p.selfPane && a.id === this.p.selfPane) a.self = true;
		this.cache = { at: this.now(), agents: [...local, ...remote.flat()], machines, unreachable };
		return this.cache;
	}

	/** list_sessions: what everything is doing in a sentence or two, and the names to switch to. */
	async list(machine?: string): Promise<Record<string, unknown>> {
		try {
			const f = await this.fleet(0);
			const want = String(machine ?? "").trim();
			const m = want ? f.machines.find((x) => squash(x) === squash(want)) : undefined;
			const local = want && !m && LOCAL_WORDS.has(want.toLowerCase());
			if (want && !m && !local) return { error: `no saved machine called ${want}`, machines: f.machines };
			const agents = local ? f.agents.filter((a) => !a.machine) : f.agents;
			return {
				summary: fleetSummary(agents, local ? [] : f.unreachable, m),
				talking_to: this.current ? spokenLabel(this.current) : "this session",
				sessions: agents.filter((a) => !m || a.machine === m).map(describeOption),
				...(f.unreachable.length ? { unreachable: f.unreachable } : {}),
				note: "Say the summary; names only if asked.",
			};
		} catch (e: any) {
			return this.failure(e);
		}
	}

	/** switch_session: by name; an ambiguous name lists at most three for the voice to ask which. */
	async switchTo(name: string): Promise<Record<string, unknown>> {
		const n = String(name ?? "").trim();
		if (!n || SELF.test(words(n).join(" "))) return this.setTarget(undefined);
		try {
			const f = await this.fleet(0);
			const r = resolveTarget(n, f.agents, f.machines);
			if (r.kind === "self") return this.setTarget(undefined);
			if (r.kind === "agent") return this.setTarget(r.agent);
			if (r.kind === "ambiguous")
				return {
					ambiguous: true,
					options: r.options.slice(0, 3).map(describeOption),
					...(r.options.length > 3 ? { more: r.options.length - 3 } : {}),
					note: "Ask which one, naming at most these three briefly; then call switch_session with the answer.",
				};
			const gone = f.unreachable.find((m) => words(n).includes(m.toLowerCase()) || squash(n).includes(squash(m)));
			if (gone) return { error: `${gone} is unreachable right now. Tell the developer.` };
			return { error: r.reason, sessions: f.agents.filter((a) => !a.self).slice(0, 8).map(describeOption) };
		} catch (e: any) {
			return this.failure(e);
		}
	}

	private setTarget(t: HerdrAgent | undefined): Record<string, unknown> {
		this.current = t;
		this.p.onTarget?.(t);
		this.p.log?.({ target: t ? agentLabel(t) : "self" });
		if (!t) return { switched: "this session", note: "Requests go to this terminal's pi again. Confirm in two or three words." };
		// A target waiting on a question: its question is read out now.
		if (t.status === "blocked") void this.follow(t, "", t.seq);
		return {
			switched: spokenLabel(t),
			status: t.status === "blocked" ? "waiting on a question (it will be read out)" : t.status,
			note: "Requests now go there. Confirm in a few words, naming it.",
		};
	}

	/** pi_status for the target. */
	async status(): Promise<string> {
		const t = this.current;
		if (!t) return "";
		try {
			const a = await this.client.get(t);
			const who = cap(spokenLabel(a));
			if (a.status === "blocked") return `${who} is waiting on a question.`;
			if (a.status === "working") return `${who} is working.`;
			if (a.status === "unknown") return `I can't tell what ${spokenLabel(a)} is doing.`;
			return `${who} is idle.`;
		} catch (e: any) {
			return e?.code === "not_found" ? "That session has ended." : `I can't reach ${spokenLabel(t)}.`;
		}
	}

	/** "Stop pi" while talking to another session: Esc interrupts its turn. */
	async stop(): Promise<Record<string, unknown>> {
		const t = this.current;
		if (!t) return { error: "no other session" };
		try {
			const a = await this.client.get(t);
			if (a.status !== "working") return { stopped: false, note: `${spokenLabel(a)} is not working` };
			await this.client.sendKeys(a, ["esc"]);
			return { stopped: true, where: spokenLabel(a) };
		} catch (e: any) {
			return this.failure(e);
		}
	}

	/**
	 * ask_pi while talking to another session: prompt it (never while it waits on a question), then
	 * follow the request in the background to its answer. A failed or unconfirmed prompt is never resent.
	 */
	async ask(text: string): Promise<Record<string, unknown>> {
		const t = this.current;
		if (!t) return { error: "no other session" };
		const label = agentLabel(t);
		let a: HerdrAgent;
		try {
			a = await this.client.get(t);
		} catch (e: any) {
			if (e?.code === "not_found") return { delivered: false, error: `${spokenLabel(t)} has ended; nothing was sent. Tell the developer.` };
			if (e?.code === "unreachable" || e?.code === "timeout") return { delivered: false, error: `${t.machine ?? "herdr"} is unreachable right now; nothing was sent. Tell the developer.` };
			return { delivered: false, ...this.failure(e) };
		}
		const blocked = () => {
			void this.follow(a, "", a.seq);
			return { delivered: false, note: `Not sent: ${spokenLabel(a)} is waiting on a question, which is read out next. Tell the developer in a few words.` };
		};
		if (a.status === "blocked") return blocked();
		try {
			await this.client.prompt(a, text);
		} catch (e: any) {
			if (e?.code === "blocked") return blocked();
			if (e?.code === "timeout" || e?.code === "stalled") {
				// It may have arrived: never resend blindly. Follow it; its screen will tell.
				this.p.log?.({ herdr: "prompt unconfirmed", target: label, error: e.message });
				this.p.show({ kind: "sent", target: label, text: `${text}  (delivery not confirmed; not resent)` });
				void this.follow(a, text, a.seq);
				return {
					delivered: "unconfirmed",
					note: `herdr did not confirm delivery to ${spokenLabel(a)}. It may have arrived, so it was not resent. Tell the developer briefly; do not call ask_pi again for it unless they ask after checking.`,
				};
			}
			if (e?.code === "not_found") return { delivered: false, error: `${spokenLabel(a)} has ended; nothing was sent.` };
			if (e?.code === "unreachable") return { delivered: false, error: `${a.machine} is unreachable; nothing was sent. Tell the developer.` };
			return { delivered: false, ...this.failure(e) };
		}
		this.p.log?.({ herdr: "prompt", target: label, text });
		this.p.show({ kind: "sent", target: label, text });
		void this.follow(a, text, a.seq);
		return { delivered: "prompt", to: spokenLabel(a), note: "It started on it there. Say nothing; its answer comes as [PI] SAY." };
	}

	/** Follows a target until it settles: questions read out, the answer briefed and shown. One per target. */
	async follow(t: HerdrAgent, request: string, beforeSeq?: number): Promise<void> {
		const k = keyOf(t);
		const existing = this.watches.get(k);
		if (existing) {
			// A newer request takes over: its answer comes only after it started (herdr's wait does not
			// track turns, so the agent being idle from the previous run must not count).
			if (request) Object.assign(existing, { request, beforeSeq, startedAt: this.now(), started: false, gen: existing.gen + 1 });
			return;
		}
		const w: Watch = { request, beforeSeq, startedAt: this.now(), started: !request, gen: 0 };
		this.watches.set(k, w);
		let failures = 0;
		try {
			if (request) {
				// See it start; a quick run may already be over (then the state counter has moved).
				try {
					const gen = w.gen;
					const a = await this.client.wait(t, ["working", "blocked"], 5000);
					if (w.gen === gen && (a.status === "working" || a.status === "blocked")) w.started = true;
				} catch {}
			}
			const deadline = this.now() + WATCH_MS;
			while (!this.closed && this.now() < deadline) {
				let a: HerdrAgent;
				try {
					a = await this.client.wait(t, ["idle", "done", "blocked"], WAIT_CHUNK_MS);
					failures = 0;
				} catch (e: any) {
					if (this.closed) return;
					if (e?.code === "timeout") {
						w.started = true;
						continue;
					}
					if (e?.code === "not_found") {
						this.p.announce("failed", `${cap(spokenLabel(t))} has ended.`);
						return;
					}
					if (++failures >= 3) {
						this.p.announce("failed", `I lost touch with ${spokenLabel(t)}${t.machine ? `; ${t.machine} is unreachable` : ""}.`, { context: String(e?.message ?? e) });
						return;
					}
					await this.sleep(3000);
					continue;
				}
				if (this.closed) return;
				if (a.status === "blocked") {
					w.started = true;
					await this.question(a);
					continue;
				}
				if (a.status === "idle" || a.status === "done") {
					// With herdr's state counter: settled only once it moved past the request's (idle from the
					// run before is not this request's answer).
					const known = a.seq !== undefined && w.beforeSeq !== undefined;
					const settled = w.started || (known && a.seq !== w.beforeSeq);
					if (!settled) {
						if (this.now() - w.startedAt < START_MS) {
							await this.sleep(500);
							continue;
						}
						if (known && w.request) {
							this.p.log?.({ herdr: "request not seen starting", target: agentLabel(a) });
							this.p.announce("failed", `${cap(spokenLabel(a))} doesn't seem to have started on it; check its screen.`);
							return;
						}
					}
					const gen = w.gen;
					if (w.request) await this.finish(a, w.request);
					// A newer request arrived meanwhile: follow it too.
					if (w.gen !== gen) continue;
					return;
				}
				w.started = true;
				await this.sleep(1000); // unknown: herdr can't classify it; look again shortly
			}
		} finally {
			this.watches.delete(k);
		}
	}

	/** The answer: the run's digest (a pi here: its session file; otherwise its screen), one spoken sentence, a written copy. */
	private async finish(a: HerdrAgent, request: string): Promise<void> {
		const label = agentLabel(a);
		let d: RunDigest | undefined;
		if (!a.machine && a.kind === "pi" && a.sessionPath) {
			const text = (this.p.readFile ?? readSession)(a.sessionPath);
			if (text) d = sessionDigest(text, request);
		}
		if (!d) {
			let screen: string;
			try {
				screen = await this.client.read(a, "recent-unwrapped", ANSWER_LINES);
			} catch (e: any) {
				this.p.announce("failed", `${cap(spokenLabel(a))} finished, but I couldn't read its answer.`, { context: String(e?.message ?? e) });
				return;
			}
			d = { request, edits: [], commands: [], errors: [], final: extractAnswer(screen, request), aborted: false };
		}
		if (this.closed) return;
		const speech = (await this.p.brief(d).catch(() => "")) || firstSentences(speakable(d.final), 1) || "Done.";
		const report = digestText(d);
		const kind: AnnounceKind = /SIGNIFICANT ACTION FAILED/.test(report) ? "failed" : /\?\s*$/.test(speech) ? "question" : "done";
		// Said plainly about the session being talked to; named when it is another one.
		const here = this.current && keyOf(this.current) === keyOf(a);
		const sentence = here ? speech : `From ${spokenLabel(a)}: ${speech}`;
		this.last = { label, text: d.final };
		this.p.show({ kind: "answer", target: label, text: compact(d.final), ...(this.p.quiet() ? {} : { said: sentence }) });
		this.p.log?.({ herdr: "answer", target: label, said: sentence, from: a.sessionPath && !a.machine ? "session" : "screen" });
		this.p.announce(kind, sentence, { context: `REPORT from ${spokenLabel(a)} (for follow-up questions, do not read out):\n${report.slice(0, 6000)}` });
	}

	/**
	 * The target waits on a question: read it from its screen and ask it by voice (select and yes/no
	 * dialogs), or say it needs the screen. Returns when the question is gone or has changed.
	 */
	private async question(a: HerdrAgent): Promise<void> {
		const k = keyOf(a);
		const label = spokenLabel(a);
		const screen = await this.client.read(a, "visible", 60).catch(() => "");
		const d = parseDialog(screen);
		const text = signatureOf(screen);
		// The same text after herdr's state counter moved is another question (asked again).
		const signature = `${text}#${a.seq ?? ""}`;
		const open = this.dialogs.get(k);
		if (open?.signature !== signature) {
			if (open) this.p.closePrompt(open.id);
			const id = `herdr-${Math.random().toString(36).slice(2, 8)}`;
			this.dialogs.set(k, { signature, id });
			if (d) {
				this.p.show({ kind: "question", target: agentLabel(a), text: `${d.title}${d.message ? ` ${d.message}` : ""}\n${d.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` });
				this.p.ask(dialogPrompt(d, cap(label), id), (v) => void this.answer(a, d, v).catch(() => {}));
			} else {
				this.p.show({ kind: "question", target: agentLabel(a), text: "waiting on a question that needs the screen" });
				this.p.announce("question", `${cap(label)} is waiting on a question that needs the screen.`);
			}
		}
		// Until it is answered (by voice, or on its own screen) or replaced by another question.
		for (let failures = 0; !this.closed; ) {
			try {
				await this.client.wait(a, ["idle", "done", "working"], 3000);
				break;
			} catch (e: any) {
				if (e?.code !== "timeout") {
					if (++failures >= 3) break;
					await this.sleep(2000);
					continue;
				}
			}
			const now = await this.client.read(a, "visible", 60).catch(() => undefined);
			if (now !== undefined && signatureOf(now) !== text) return;
			if (a.seq !== undefined) {
				const cur = await this.client.get(a).catch(() => undefined);
				if (cur?.seq !== undefined && cur.seq !== a.seq) return;
			}
		}
		const gone = this.dialogs.get(k);
		if (gone?.signature === signature) {
			this.p.closePrompt(gone.id);
			this.dialogs.delete(k);
		}
	}

	/**
	 * A spoken answer to a question on another screen: keys only if that exact question is still there.
	 * The same question: the same text, and herdr's state counter has not moved since it was read (two
	 * dialogs in a row can read the same). The arrows go first; Enter only once a fresh read shows the
	 * cursor on the chosen option.
	 */
	private async answer(a: HerdrAgent, d: ScreenDialog, value: unknown): Promise<void> {
		const label = spokenLabel(a);
		if (!keysFor(d, value)) {
			this.p.announce("question", `I can't give that answer on ${label}; it needs the screen.`);
			return;
		}
		const changed = () => this.p.announce("question", `The question on ${label} changed; nothing was answered.`);
		const same = async (): Promise<ScreenDialog | undefined> => {
			const cur = await this.client.get(a);
			if (cur.status !== "blocked" || (a.seq !== undefined && cur.seq !== a.seq)) return undefined;
			const now = parseDialog(await this.client.read(a, "visible", 60));
			return now && now.signature === d.signature ? now : undefined;
		};
		try {
			const now = await same();
			if (!now) return changed();
			// From where the cursor is now.
			const keys = keysFor(now, value)!;
			const arrows = keys.slice(0, -1);
			if (arrows.length) {
				await this.client.sendKeys(a, arrows);
				const moved = await same();
				if (!moved || keysFor(moved, value)!.length !== 1) {
					this.p.log?.({ herdr: "answer not confirmed", target: agentLabel(a), arrows });
					this.p.announce("question", `I couldn't confirm the choice on ${label}; nothing was answered. It needs the screen.`);
					return;
				}
			}
			await this.client.sendKeys(a, keys.slice(-1));
			this.p.log?.({ herdr: "answered", target: agentLabel(a), keys });
			this.p.show({ kind: "note", target: agentLabel(a), text: `answered: ${value === undefined ? "cancelled" : typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}` });
		} catch (e: any) {
			if (this.closed) return;
			this.p.announce("failed", `I couldn't answer on ${label}: ${e?.code === "unreachable" ? `${a.machine} is unreachable` : "it needs the screen"}.`);
		}
	}
}
