// rpiv's `ask_user_question`, answerable from the phone.
//
// The tool asks through `ctx.ui.custom`: a tabbed terminal overlay no bridge can mirror. But it publishes
// every questionnaire on `rpiv:ask-user:prompt` and accepts an answer on `rpiv:ask-user:answer` — a contract
// it writes for "a phone or web bridge" — so the phone gets one card per question, the way the tool's own
// RPC host does. The terminal keeps its overlay: first answer wins, on either side.
//
// What the phone cannot show from this contract: an option's preview text (the event only flags that one
// exists) and per-question notes.

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "./bridge.ts";
import type { Prompt } from "./protocol.ts";

const PROMPT_EVENT = "rpiv:ask-user:prompt";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";
const ANSWER_EVENT = "rpiv:ask-user:answer";

interface RpivOption {
	label: string;
	description?: string;
}

interface RpivQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options?: RpivOption[];
}

interface Entry {
	questionIndex: number;
	optionIndexes?: number[];
	text?: string;
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null;

/** Watch the tool's questionnaires and hand them to the phone. */
export function rpivToPhone(pi: ExtensionAPI, bridge: () => Bridge | undefined): void {
	const bus = pi.events;
	if (!bus) return; // a host without the cross-extension bus never runs the tool that uses it
	// The card on screen per questionnaire, so the terminal answering takes it back.
	const cards = new Map<string, string>();
	// Cards pulled because the tool moved on: those must not be reported as a decline.
	const gone = new Set<string>();

	bus.on(BLOCKED_EVENT, (data: unknown) => {
		if (!isRecord(data) || data.active !== false || typeof data.toolCallId !== "string") return;
		const id = cards.get(data.toolCallId);
		cards.delete(data.toolCallId);
		if (id) {
			gone.add(id);
			bridge()?.dropPhone(id);
		}
	});

	bus.on(PROMPT_EVENT, (data: unknown) => {
		if (!isRecord(data) || typeof data.toolCallId !== "string") return;
		const questions: RpivQuestion[] = Array.isArray(data.questions) ? data.questions : [];
		if (!questions.length || cards.has(data.toolCallId)) return;
		const b = bridge();
		// No phone watching: leave the questionnaire to the terminal.
		if (!b?.isLinked) return;
		void askAll(b, bus, cards, gone, data.toolCallId, questions);
	});
}

async function askAll(b: Bridge, bus: EventBus, cards: Map<string, string>, gone: Set<string>, toolCallId: string, questions: RpivQuestion[]): Promise<void> {
	const answers: Entry[] = [];
	for (const [i, q] of questions.entries()) {
		const { id, answer } = b.phone(card(i, questions.length, q));
		cards.set(toolCallId, id);
		const value = await answer;
		cards.delete(toolCallId);
		if (value === undefined && gone.delete(id)) return; // answered at the desk: say nothing
		if (value === undefined || (typeof value === "string" && !value.trim())) {
			bus.emit(ANSWER_EVENT, { toolCallId, cancel: true }); // declined on the card, or submitted empty
			return;
		}
		answers.push({ questionIndex: i, ...picked(q, value) });
	}
	bus.emit(ANSWER_EVENT, { toolCallId, answers });
}

/** One question as one card: a list to tap, or numbers to type when several fit. */
function card(i: number, n: number, q: RpivQuestion): Omit<Prompt, "id"> {
	const title = `${q.header || `Question ${i + 1}`}${n > 1 ? ` · ${i + 1}/${n}` : ""}`;
	const labels = (q.options ?? []).map((o) => o.label);
	if (!q.multiSelect && labels.length) return { kind: "select", title, message: q.question, options: labels };
	const rows = (q.options ?? []).map((o, k) => `${k + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
	return {
		kind: "input",
		title,
		message: [q.question, ...rows].filter(Boolean).join("\n"),
		placeholder: rows.length ? "1,3 or your own answer" : "your answer",
	};
}

/** What the card returned, in the tool's own shape. */
function picked(q: RpivQuestion, value: unknown): Pick<Entry, "optionIndexes" | "text"> {
	const labels = (q.options ?? []).map((o) => o.label);
	const text = String(value).trim();
	const exact = labels.indexOf(text);
	if (!q.multiSelect) return exact >= 0 ? { optionIndexes: [exact] } : { text };
	// Multi-select reads the way the tool's own host does: option numbers, then anything after `;` as your own answer.
	const [head, ...rest] = text.split(";");
	const note = rest.join(";").trim();
	const withNote = note ? { text: note } : {};
	if (exact >= 0) return { optionIndexes: [exact], ...withNote };
	const indexes = [...new Set((head.match(/\d+/g) ?? []).map((d) => Number(d) - 1).filter((k) => k >= 0 && k < labels.length))];
	return indexes.length ? { optionIndexes: indexes, ...withNote } : { text };
}
