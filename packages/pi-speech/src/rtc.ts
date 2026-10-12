// The realtime call from the terminal: WebRTC in Node with werift (pure TypeScript), Opus encoded and
// decoded in-process with opusscript (libopus compiled to wasm), so pi-speech needs no native build.
// The call is created like the phone's (createCall in realtime.ts: the ChatGPT sign-in's Codex endpoint,
// or the public API with OPENAI_API_KEY); events travel on the "oai-events" data channel. WebSocket on
// chatgpt.com is refused, which is why this is WebRTC (spike 2026-10-11, designs/voice-modalities.md).

import { createCall, type RealtimeCredentials } from "./realtime.ts";

export const RTC_RATE = 48000;
const FRAME = 960; // 20 ms at 48 kHz
const OPUS_PT = 111;

export interface RealtimeLink {
	/** A client event on the data channel (dropped when it is not open). */
	send(ev: Record<string, unknown>): void;
	onEvent(fn: (ev: any) => void): void;
	/** Microphone audio: 48 kHz mono s16le, any chunk size; sent as 20 ms Opus frames. */
	sendPcm(pcm: Buffer): void;
	/** The model's audio, decoded: 48 kHz mono s16le. */
	onAudio(fn: (pcm: Buffer) => void): void;
	/** The connection failed or closed by itself. */
	onClose(fn: (why: string) => void): void;
	close(): Promise<void>;
	readonly callId?: string;
}

/** Builds 12-byte RTP headers around Opus frames (werift's sender rewrites SSRC and payload type). */
export class RtpFramer {
	private seq = Math.floor(Math.random() * 0xffff);
	private ts = Math.floor(Math.random() * 2 ** 31);
	private first = true;

	packet(payload: Buffer, samples = FRAME): Buffer {
		const h = Buffer.alloc(12);
		h[0] = 0x80;
		h[1] = (this.first ? 0x80 : 0) | OPUS_PT;
		h.writeUInt16BE(this.seq, 2);
		h.writeUInt32BE(this.ts >>> 0, 4);
		h.writeUInt32BE(0x5049, 8);
		this.seq = (this.seq + 1) & 0xffff;
		this.ts = (this.ts + samples) >>> 0;
		this.first = false;
		return Buffer.concat([h, payload]);
	}
}

/** Splits arbitrary PCM chunks into whole 20 ms frames. */
export class Framer {
	private pending: Buffer = Buffer.alloc(0);

	push(pcm: Buffer, each: (frame: Buffer) => void): void {
		this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
		while (this.pending.length >= FRAME * 2) {
			each(this.pending.subarray(0, FRAME * 2));
			this.pending = this.pending.subarray(FRAME * 2);
		}
	}
}

export interface ConnectOptions {
	fetch?: typeof fetch;
	/** How long to wait for the data channel (default 15 s). */
	timeoutMs?: number;
}

/** Opens the realtime call and resolves when the data channel is open. */
export async function connectRealtime(creds: RealtimeCredentials, session: Record<string, unknown>, o: ConnectOptions = {}): Promise<RealtimeLink> {
	const { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } = await import("werift");
	const { default: OpusScript } = await import("opusscript");
	const pc = new RTCPeerConnection({
		codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: RTC_RATE, channels: 2, payloadType: OPUS_PT })] },
	});
	const local = new MediaStreamTrack({ kind: "audio" });
	pc.addTransceiver(local, { direction: "sendrecv" });
	const dc = pc.createDataChannel("oai-events");
	const encoder = new OpusScript(RTC_RATE, 1, OpusScript.Application.VOIP);
	encoder.encoderCTL(4002, 32000); // OPUS_SET_BITRATE
	const decoder = new OpusScript(RTC_RATE, 1, OpusScript.Application.VOIP);
	const events: ((e: any) => void)[] = [];
	const audio: ((pcm: Buffer) => void)[] = [];
	const closers: ((why: string) => void)[] = [];
	let closed = false;
	/** Fails the wait for the data channel: closing before it opened is a failed connection, not a hang. */
	let failOpen: ((e: Error) => void) | undefined;
	const lost = (why: string) => {
		if (closed) return;
		closed = true;
		failOpen?.(new Error(`realtime voice did not connect: ${why}`));
		for (const f of closers) f(why);
	};
	dc.onMessage.subscribe((m: unknown) => {
		let ev: any;
		try {
			ev = JSON.parse(String(m));
		} catch {
			return;
		}
		for (const f of events) f(ev);
	});
	pc.onTrack.subscribe((t: any) =>
		t.onReceiveRtp.subscribe((rtp: any) => {
			if (closed) return;
			let pcm: Buffer;
			try {
				// No jitter buffer: decoded in arrival order (fine on the networks this runs on).
				pcm = Buffer.from(decoder.decode(rtp.payload));
			} catch {
				return;
			}
			for (const f of audio) f(pcm);
		}),
	);
	pc.connectionStateChange.subscribe((s: string) => {
		if (s === "failed" || s === "closed") lost(`connection ${s}`);
	});
	dc.stateChanged.subscribe((s: string) => {
		if (s === "closed") lost("data channel closed");
	});
	const opened = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("realtime voice did not connect")), o.timeoutMs ?? 15_000);
		failOpen = (e) => {
			clearTimeout(timer);
			reject(e);
		};
		dc.stateChanged.subscribe((s: string) => {
			if (s === "open") {
				clearTimeout(timer);
				failOpen = undefined;
				resolve();
			}
		});
	});
	opened.catch(() => {});
	const shut = async () => {
		closed = true;
		try {
			dc.close();
		} catch {}
		try {
			await pc.close();
		} catch {}
		try {
			encoder.delete();
			decoder.delete();
		} catch {}
	};
	let call: { sdp: string; callId?: string };
	try {
		await pc.setLocalDescription(await pc.createOffer());
		call = await createCall(creds, pc.localDescription!.sdp, session, o.fetch);
		await pc.setRemoteDescription({ type: "answer", sdp: call.sdp } as any);
		await opened;
	} catch (e) {
		await shut();
		throw e;
	}
	const framer = new Framer();
	const rtp = new RtpFramer();
	return {
		callId: call.callId,
		send: (ev) => {
			if (!closed && dc.readyState === "open") dc.send(JSON.stringify(ev));
		},
		onEvent: (f) => void events.push(f),
		onAudio: (f) => void audio.push(f),
		onClose: (f) => void closers.push(f),
		sendPcm: (pcm) => {
			if (closed) return;
			framer.push(pcm, (frame) => local.writeRtp(rtp.packet(encoder.encode(frame, FRAME))));
		},
		close: shut,
	};
}
