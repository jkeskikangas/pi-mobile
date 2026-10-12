// Next-prompt suggestions from another extension (pi-next-turn), received on `pi.events` only:
// pi-mobile does not depend on it. No events, no suggestions.
//
//   next-turn:ready      {version}                                         an engine is loaded (session_start)
//   next-turn:prediction {id, sessionId, candidates, readAhead, draft?, at}  replaces one with the same id
//   next-turn:clear      {id}                                              it no longer applies

/** A candidate this likely (calibrated) is worth offering unasked: in the push body and by voice. */
export const P_READ = 0.7;
const MAX_CANDIDATES = 3;
const MAX_TEXT = 300;

export interface Draft {
	files: number;
	insertions: number;
	deletions: number;
	checks?: "pass" | "fail" | "none";
}

export interface Suggestion {
	id: string;
	candidates: { text: string; p: number }[];
	readAhead: "none" | "running" | "ready";
	draft?: Draft;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Validates a `next-turn:prediction` payload: up to three candidates, most likely first. */
export function parsePrediction(data: unknown): (Suggestion & { sessionId?: string }) | undefined {
	const d = data as any;
	if (!d || typeof d.id !== "string" || !d.id || !Array.isArray(d.candidates)) return undefined;
	const candidates: { text: string; p: number }[] = d.candidates
		.filter((c: any) => typeof c?.text === "string" && c.text.trim() && typeof c.p === "number" && Number.isFinite(c.p))
		.map((c: any) => ({ text: c.text.trim().slice(0, MAX_TEXT), p: Math.min(1, Math.max(0, c.p)) }))
		.sort((a: { p: number }, b: { p: number }) => b.p - a.p)
		.slice(0, MAX_CANDIDATES);
	if (!candidates.length) return undefined;
	const readAhead = d.readAhead === "running" || d.readAhead === "ready" ? d.readAhead : "none";
	const dr = d.draft;
	const draft: Draft | undefined =
		dr && typeof dr === "object"
			? {
					files: count(dr.files),
					insertions: count(dr.insertions),
					deletions: count(dr.deletions),
					...(dr.checks === "pass" || dr.checks === "fail" || dr.checks === "none" ? { checks: dr.checks } : {}),
				}
			: undefined;
	return { id: d.id, ...(typeof d.sessionId === "string" ? { sessionId: d.sessionId } : {}), candidates, readAhead, ...(draft ? { draft } : {}) };
}

/** The top candidate when it is confident enough to offer unasked. */
export function confident(s: Suggestion | undefined): { text: string; p: number } | undefined {
	const top = s?.candidates[0];
	return top && top.p >= P_READ ? top : undefined;
}

/** "3 files · tests pass": what a prepared draft changes, in words (the phone's chip says the same). */
export function draftSummary(d: Draft): string {
	const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
	return d.checks === "pass" ? `${files} · tests pass` : d.checks === "fail" ? `${files} · tests fail` : files;
}

const BODY_REPLY = 160;

/** The "finished" notification body: pi's last words, then "Next: …?" when a confident suggestion exists. */
export function finishedBody(last: string, s: Suggestion | undefined): string {
	const top = confident(s);
	if (!top || !s) return last || "pi is idle.";
	const reply = last.length > BODY_REPLY ? `${last.slice(0, BODY_REPLY - 1)}…` : last;
	const next = `Next: ${top.text.replace(/[?.!\s]+$/, "")}?${s.draft ? ` Draft ready: ${draftSummary(s.draft)}.` : ""}`;
	return reply ? `${reply}\n${next}` : next;
}
