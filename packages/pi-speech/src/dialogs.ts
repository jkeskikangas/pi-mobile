// pi's questions by voice in the terminal: an extension dialog (select, confirm, input) raised while
// voice mode is on is read out and can be answered aloud. The rules are the phone's
// (web/voice-core.js answerFor/speakPrompt): at most two options at a time, and an irreversible
// action needs its name in the answer ("yes, deploy"), never a bare "yeah".

export interface VoicePrompt {
	id: string;
	kind: "select" | "confirm" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
}

export const norm = (s: unknown) =>
	String(s || "")
		.toLowerCase()
		.replace(/[’']/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Drops a leading "ok so", "hey pi". */
export const stripLead = (s: string) => s.replace(/^(?:(?:hey|ok|okay|so|um|uh|and|alright)\s+)*(?:pi\s+)?/, "").trim();

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|please do|correct|right|affirmative|confirm(?:ed)?|of course|sounds good)\b/;
const NO = /^(?:no|nope|nah|don't|do not|negative|cancel|stop|never ?mind|not now|skip)\b/;
const ORDINALS: Record<string, number> = { one: 1, first: 1, "1": 1, two: 2, second: 2, "2": 2, three: 3, third: 3, "3": 3, four: 4, fourth: 4, "4": 4, five: 5, fifth: 5, "5": 5, last: -1 };
const DESTRUCTIVE = /\b(push|force|deploy|publish|release|delete|remove|rm|drop|truncate|wipe|reset|overwrite|destroy|send|email|post|pay|purchase|merge|rebase|migrate|production|prod)\b/i;

export const isDestructive = (p: Pick<VoicePrompt, "title" | "message">) => DESTRUCTIVE.test(`${p.title || ""} ${p.message || ""}`);

function actionWord(p: Pick<VoicePrompt, "title" | "message">): string | null {
	const m = DESTRUCTIVE.exec(`${p.title || ""} ${p.message || ""}`);
	return m ? m[1].toLowerCase() : null;
}

export type Answer = { value: unknown } | { needConfirm: string } | { unclear: true };

/** A spoken reply as a dialog answer: `{value}`, `{needConfirm: word}` for a destructive yes that didn't name the action, or `{unclear}`. */
export function answerFor(prompt: VoicePrompt, text: string): Answer {
	const t = stripLead(norm(text));
	if (prompt.kind === "confirm") {
		if (NO.test(t)) return { value: false };
		if (YES.test(t) || /\bconfirm\b/.test(t)) {
			const word = isDestructive(prompt) ? actionWord(prompt) : null;
			if (word && !new RegExp(`\\b(${word}|confirm)`).test(t)) return { needConfirm: word };
			return { value: true };
		}
		return { unclear: true };
	}
	if (prompt.kind === "select") {
		const options = prompt.options ?? [];
		if (/^(?:cancel|none|neither|never ?mind|skip)\b/.test(t)) return { value: undefined };
		const ord = /(?:option|number|the)?\s*\b(one|two|three|four|five|first|second|third|fourth|fifth|last|[1-5])\b(?:\s+(?:one|option))?$/.exec(t);
		if (ord && t.split(" ").length <= 4) {
			const n = ORDINALS[ord[1]];
			const i = n === -1 ? options.length - 1 : n - 1;
			if (options[i] !== undefined) return confirmSelect(options[i], t);
		}
		let best: { o: string; score: number } | null = null;
		for (const o of options) {
			const words = norm(o)
				.split(" ")
				.filter((w) => w.length > 2);
			const score = words.length ? words.filter((w) => t.includes(w)).length / words.length : 0;
			if (score > 0.5 && (!best || score > best.score)) best = { o, score };
		}
		if (best) return confirmSelect(best.o, t);
		if (options.length === 2 && YES.test(t)) return confirmSelect(options[0], t);
		return { unclear: true };
	}
	if (/^(?:cancel|never ?mind|skip)$/.test(t)) return { value: undefined };
	return { value: String(text || "").trim() };
}

function confirmSelect(option: string, t: string): Answer {
	const word = DESTRUCTIVE.exec(option);
	if (word && !new RegExp(`\\b(${word[1].toLowerCase()}|confirm)`).test(t)) return { needConfirm: word[1].toLowerCase() };
	return { value: option };
}

/** Ends `s` as a sentence: a full stop only when it has no closing punctuation ("Save the color?" stays). */
export function sentence(s: string): string {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!t) return "";
	return /[.?!:…]["')”’]*$/.test(t) ? t : `${t.replace(/[,;]+$/, "")}.`;
}

/** How a dialog is asked aloud: the question, then at most two options. */
export function speakPrompt(prompt: VoicePrompt): string {
	const q = [sentence(prompt.title || ""), sentence(prompt.message || "")].filter(Boolean).join(" ");
	const ask = (rest: string) => (q ? `${q} ${rest}` : rest);
	if (prompt.kind === "confirm") {
		const word = isDestructive(prompt) ? actionWord(prompt) : null;
		return ask(word ? `Say "yes, ${word}" to confirm, or no.` : "Yes or no?");
	}
	if (prompt.kind === "select") {
		const o = prompt.options ?? [];
		const named = o.slice(0, 2).map((x, i) => sentence(`${["one", "two"][i]}: ${x}`));
		const rest = o.length > 2 ? ` There are ${o.length} on screen.` : "";
		return ask(`${named.join(" ")}${rest}`.trim());
	}
	return ask("What should I answer?");
}

/** The [PI] context the voice model gets with a question, so it can map the answer. */
export function promptContext(prompt: VoicePrompt): string {
	const destructive = isDestructive(prompt);
	const opts = prompt.options?.length ? `\nOptions: ${prompt.options.map((o, i) => `${i + 1}. ${o}`).join("; ")}` : "";
	return `QUESTION (id ${prompt.id}, ${prompt.kind}${destructive ? ", DESTRUCTIVE: needs explicit confirmation naming the action" : ""}): ${prompt.title}${prompt.message ? ` — ${prompt.message}` : ""}${opts}`;
}
