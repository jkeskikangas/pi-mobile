// Prompts from two pi extensions that don't go through ctx.ui.select/confirm/input, so the dialog
// bridge can't see them: @juicesharp/rpiv-ask-user-question (a tabbed form) and
// @gotgenes/pi-permission-system (an inline dialog in the terminal UI). Both announce themselves on
// pi's event bus; ask-user-question also takes answers on it. These are the pure mappings between
// their event payloads and a phone prompt; bridge.ts does the wiring.

import type { PermissionAction, Prompt, PromptAnswer, PromptQuestion } from "./protocol.ts";

export const ASK_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ASK_ANSWER_EVENT = "rpiv:ask-user:answer";
export const ASK_RESULT_EVENT = "rpiv:ask-user:answer-result";
export const PERMISSION_PROMPT_EVENT = "permissions:ui_prompt";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function questionnaireId(toolCallId: string): string {
	return `ask:${toolCallId}`;
}

/** The phone card for an `rpiv:ask-user:prompt`, or undefined if the payload isn't one. */
export function questionnairePrompt(raw: unknown): { toolCallId: string; prompt: Prompt } | undefined {
	if (!isRecord(raw) || typeof raw.toolCallId !== "string" || !Array.isArray(raw.questions) || !raw.questions.length) return undefined;
	const questions: PromptQuestion[] = raw.questions.filter(isRecord).map((q) => ({
		question: str(q.question),
		header: str(q.header),
		multiSelect: q.multiSelect === true,
		options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) => ({ label: str(o.label), description: str(o.description) })),
	}));
	const title = questions.length === 1 ? questions[0].question : `${questions.length} questions`;
	return { toolCallId: raw.toolCallId, prompt: { id: questionnaireId(raw.toolCallId), kind: "questionnaire", title, questions } };
}

/**
 * The `rpiv:ask-user:answer` payload for a phone's answer (undefined declines). The extension validates
 * it strictly and all-or-nothing; this only drops fields of the wrong type so a bad phone can't smuggle any in.
 */
export function answerPayload(toolCallId: string, requestId: string, value: unknown): Record<string, unknown> {
	if (value === undefined) return { toolCallId, requestId, cancel: true };
	if (!isRecord(value) || !Array.isArray(value.answers)) throw new Error("expected answers");
	const answers: PromptAnswer[] = value.answers.filter(isRecord).map((a) => ({
		questionIndex: a.questionIndex as number,
		...(Array.isArray(a.optionIndexes) ? { optionIndexes: a.optionIndexes as number[] } : {}),
		...(typeof a.text === "string" ? { text: a.text } : {}),
		...(typeof a.notes === "string" && a.notes.trim() ? { notes: a.notes } : {}),
	}));
	return {
		toolCallId,
		requestId,
		answers,
		...(typeof value.globalNote === "string" && value.globalNote.trim() ? { globalNote: value.globalNote } : {}),
	};
}

export function permissionId(requestId: string): string {
	return `perm:${requestId}`;
}

/** The phone card for a `permissions:ui_prompt`, shown while the terminal's inline dialog is up. */
export function permissionPrompt(raw: unknown): Prompt | undefined {
	if (!isRecord(raw) || typeof raw.requestId !== "string") return undefined;
	const request = isRecord(raw.request) ? raw.request : {};
	const forwarding = isRecord(raw.forwarding) ? raw.forwarding : undefined;
	const surface = str(raw.surface) || str(request.surface);
	const value = str(raw.value) || str(request.value);
	const who = str(forwarding?.requesterAgentName) || str(raw.agentName);
	const rule = str(request.matchedPattern);
	const lines = [
		who ? `${who} wants to use ${surface || "a tool"}` : surface ? `Wants to use ${surface}` : "",
		value,
		rule ? `Matched rule: ${rule}` : "",
	].filter(Boolean);
	return {
		id: permissionId(raw.requestId),
		kind: "permission",
		title: forwarding ? "Permission required (subagent)" : "Permission required",
		...(lines.length ? { message: lines.join("\n") } : {}),
	};
}

/** The permission system's decision for a phone's choice, in the shape its own dialog hands back. */
export function permissionDecision(value: unknown): Record<string, unknown> {
	const action = isRecord(value) ? (value.action as PermissionAction) : undefined;
	if (action === "approve") return { approved: true, state: "approved" };
	if (action === "session") return { approved: true, state: "approved_for_session" };
	if (action === "deny") {
		const reason = isRecord(value) && typeof value.reason === "string" ? value.reason.trim() : "";
		return reason ? { approved: false, state: "denied_with_reason", denialReason: reason } : { approved: false, state: "denied" };
	}
	throw new Error("expected approve, session or deny");
}
