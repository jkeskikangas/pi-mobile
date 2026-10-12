// Parking (designs/voice-modalities.md, Input rule 2): a spoken request that points at something still
// to come ("rename it to the following", "use this:") is not sent. Its words wait in pi's editor as a
// marked segment; the developer types the rest and Enter (or saying "send") sends one message. The
// voice model has a `park` tool, and this local check catches what the model misses.

/** Marks the spoken segment at the start of the editor; stripped before the message reaches pi. */
export const PARK_MARK = "● ";

const norm = (s: string) =>
	String(s || "")
		.toLowerCase()
		.replace(/[’']/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Words people trail off with that don't change what the sentence points at. */
const TRAILING_FILLER = /(?:\s+(?:please|um+|uh+|er|okay|ok|then|now|so))+$/;

/**
 * Does this spoken request point at something still to come? True when it ends in "following",
 * "below", "as follows", a final "to" or "as", or a colon or ellipsis. A final "this", "these" or
 * "that" points at the editor when it has text (rule 5: it assembles the same line); without editor
 * text it means the last thing pi showed, so the request is complete and goes to pi.
 */
export function pointsAhead(text: string, editorHasText = false): boolean {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const t = norm(raw).replace(TRAILING_FILLER, "");
	if (!t || t.split(" ").length < 2) return false;
	if (/(?::|…|\.\.\.)\s*$/.test(raw)) return true;
	if (/\b(?:the following|following|below|as follows|like so)$/.test(t)) return true;
	if (/\b(?:to|as|into|with)$/.test(t)) return true;
	if (/\b(?:this|these|that|this one)$/.test(t)) return editorHasText;
	return false;
}

/** The editor's text without the parked marker. */
export function unmark(text: string): string {
	return String(text ?? "").startsWith(PARK_MARK) ? text.slice(PARK_MARK.length) : String(text ?? "");
}

export function isParkedText(text: string): boolean {
	return String(text ?? "").startsWith(PARK_MARK);
}

/**
 * The editor line for a parked request: the marked spoken words, a colon, then whatever was already
 * in the editor (so "rename it to this" + typed "foo.ts" reads "● rename it to this: foo.ts").
 */
export function parkLine(words: string, editor = ""): string {
	const spoken = String(words || "")
		.trim()
		.replace(/(?:\s*(?:…|\.\.\.|[.:,;!?]))+$/, "");
	const rest = unmark(editor).trim();
	return `${PARK_MARK}${spoken}: ${rest}`;
}

/** What pi receives for a parked line: the spoken words and the typed text, typed text verbatim. */
export function parkedMessage(editor: string): string {
	return unmark(editor).trim();
}
