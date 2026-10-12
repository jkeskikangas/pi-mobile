// The recogniser as dictation sees it: everything heard so far, which part of it is settled, and
// the full text at the end. Kept in one place so recogniser quirks over long recordings can be
// handled here without touching dictation or drafting. (Apple's SpeechAnalyzer was measured over a
// continuous 10.5-minute stream: no stall and no loss of accuracy over time, so one stream per
// dictation is enough; segments settle every 5-12 s, at pauses. OpenAI's recogniser settles a piece
// of about a minute at a time, cut at a pause: see piecewiseLive in stt.ts.)

import { MIC_RATE } from "./mic.ts";
import type { LiveTranscription, SttProvider } from "./stt.ts";

export class Listening {
	/** Everything heard so far, settled or not. */
	text = "";
	/** Called with everything heard so far whenever it changes. */
	onText: (text: string) => void = () => {};
	/** Everything settled so far. */
	settled = "";
	/** The words after the settled text, which may still change. */
	volatile = "";
	/** Called with each segment the recogniser settled on (in order), with all settled text so far. */
	onFinal: (segment: string, settled: string) => void = () => {};
	/** Called when the unsettled words change. */
	onVolatile: (tail: string) => void = () => {};
	private live: LiveTranscription;

	constructor(stt: SttProvider, hints: string[], rate = MIC_RATE) {
		if (!stt.live) throw new Error(`${stt.name} recognition can't listen live`);
		this.live = stt.live(rate, hints);
		this.live.onPartial = (t) => {
			if (t === this.text) return;
			this.text = t;
			this.onText(t);
		};
		this.live.onFinal = (s) => {
			this.settled = this.settled ? `${this.settled} ${s}` : s;
			this.onFinal(s, this.settled);
		};
		this.live.onVolatile = (t) => {
			this.volatile = t;
			this.onVolatile(t);
		};
	}

	write(pcm: Buffer): void {
		this.live.write(pcm);
	}

	/** Ends input; resolves with the full transcript. */
	async end(): Promise<string> {
		const t = await this.live.end();
		this.text = t.text.trim();
		return this.text;
	}

	cancel(): void {
		this.live.cancel();
	}
}
