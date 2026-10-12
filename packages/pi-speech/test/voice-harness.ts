// The terminal voice session with fakes: a fake clock, a fake realtime channel (what was sent), a fake
// player (what was played) and a fake pi. Shared by voice-mode.test.ts and monologue.test.ts.

import { type Clock, VoiceSession, type VoicePorts, type VoiceSwitch } from "../src/voice-session.ts";

export class FakeClock implements Clock {
	t = 0;
	private seq = 0;
	private timers: { at: number; fn: () => void; id: number }[] = [];
	now() {
		return this.t;
	}
	setTimeout(fn: () => void, ms: number) {
		const id = ++this.seq;
		this.timers.push({ at: this.t + ms, fn, id });
		return id;
	}
	clearTimeout(id: unknown) {
		this.timers = this.timers.filter((x) => x.id !== id);
	}
	/** Timers still waiting to fire. */
	pending(): number {
		return this.timers.length;
	}
	advance(ms: number) {
		const end = this.t + ms;
		for (;;) {
			const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!next) break;
			this.timers = this.timers.filter((x) => x !== next);
			this.t = next.at;
			next.fn();
		}
		this.t = end;
	}
}

export const LOUD = Buffer.alloc(1920, 0x40); // 10 ms of non-silent PCM

export function harness(sw: VoiceSwitch = "normal", extra: Partial<VoicePorts> = {}) {
	const clock = new FakeClock();
	const sent: any[] = [];
	const played: string[] = [];
	let flushes = 0;
	const switches: VoiceSwitch[] = [];
	const pi = {
		idle: true,
		editor: "",
		messages: [] as { text: string; deliverAs?: string }[],
		aborted: 0,
		notes: [] as string[],
		hint: false,
		isIdle() {
			return this.idle;
		},
		send(text: string, deliverAs?: string) {
			this.messages.push({ text, deliverAs });
		},
		abort() {
			this.aborted++;
		},
		getEditorText() {
			return this.editor;
		},
		setEditorText(t: string) {
			this.editor = t;
		},
		notify(m: string) {
			this.notes.push(m);
		},
		status: () => "pi is idle.",
		details: async (topic: string) => `details about ${topic}`,
		parkHint(on: boolean) {
			this.hint = on;
		},
	};
	const s = new VoiceSession(
		{
			send: (ev) => sent.push(ev),
			player: {
				write: (pcm) => played.push(pcm.toString("latin1").startsWith("EARCON:") ? pcm.toString("latin1").slice(7) : "audio"),
				flush: () => void flushes++,
			},
			earcon: (name) => Buffer.from(`EARCON:${name}`, "latin1"),
			pi,
			clock,
			instructions: (x) => `instructions for ${x}`,
			onSwitch: (x) => switches.push(x),
			...extra,
		},
		sw,
	);
	s.open();
	played.length = 0; // the "listening" earcon
	const types = () => sent.map((e) => e.type);
	const injected = () => sent.filter((e) => e.type === "conversation.item.create" && e.item.type === "message").map((e) => e.item.content[0].text as string);
	const outputs = () => sent.filter((e) => e.item?.type === "function_call_output").map((e) => JSON.parse(e.item.output));
	const ev = (type: string, extra: Record<string, unknown> = {}) => s.onRealtime({ type, ...extra });
	/** The developer says something: a server VAD turn with its transcript. */
	const say = (transcript: string, item = `item_${Math.random()}`) => {
		ev("input_audio_buffer.speech_started");
		ev("input_audio_buffer.speech_stopped");
		ev("input_audio_buffer.committed", { item_id: item });
		ev("conversation.item.input_audio_transcription.completed", { item_id: item, transcript });
	};
	const call = async (name: string, args: Record<string, unknown>) => {
		const id = `call_${Math.random()}`;
		ev("response.function_call_arguments.done", { call_id: id, name, arguments: JSON.stringify(args) });
		await new Promise((r) => setImmediate(r));
		return outputs().at(-1);
	};
	return { s, clock, sent, played, pi, switches, types, injected, outputs, ev, say, call, flushes: () => flushes };
}
