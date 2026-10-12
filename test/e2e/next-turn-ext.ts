// A stand-in for pi-next-turn, for test/e2e/next.mjs: it emits the same pi.events contract and needs no
// model. On start it predicts "e2e: run the checks"; a message starting "e2e:" is handled here
// (appended to $NEXT_LOG, no model run) and followed by a new prediction; any key typed in the
// terminal clears the prediction, as the real one does when you type first.
//
//   pi -e ./src/index.ts -e ./test/e2e/next-turn-ext.ts
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const log = (line: string) => appendFileSync(process.env.NEXT_LOG || "/tmp/pi-mobile-e2e-next.log", `${new Date().toISOString()} ${line}\n`);
	let n = 0;
	let current: string | undefined;
	let session = "";
	const predict = () => {
		current = `e2e${++n}`;
		const candidates = [
			{ text: n === 1 ? "e2e: run the checks" : "e2e: open a PR", p: 0.9 },
			{ text: "e2e: something else", p: 0.05 },
		];
		pi.events.emit("next-turn:prediction", { id: current, sessionId: session, candidates, readAhead: "ready", at: Date.now() });
		log(`predicted ${current}`);
	};
	const clear = (why: string) => {
		if (!current) return;
		pi.events.emit("next-turn:clear", { id: current });
		log(`cleared ${current} (${why})`);
		current = undefined;
	};
	pi.on("session_start", async (_e, ctx) => {
		session = ctx.sessionManager.getSessionId();
		pi.events.emit("next-turn:ready", { version: 1 });
		if (ctx.mode === "tui") ctx.ui.onTerminalInput(() => (clear("typed in the terminal"), undefined));
		setTimeout(predict, 1500);
	});
	pi.on("input", async (event) => {
		if (!event.text.startsWith("e2e:")) return { action: "continue" };
		clear("sent");
		log(`sent ${JSON.stringify(event.text)} from ${event.source}`);
		setTimeout(predict, 1500);
		return { action: "handled" };
	});
}
