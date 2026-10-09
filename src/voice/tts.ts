// Optional spoken output from the computer for basic voice mode (the realtime model speaks for
// itself). Any OpenAI-compatible /v1/audio/speech works: a local server such as Voicebox or Kokoro
// (`voice.ttsUrl`), or OpenAI's gpt-4o-mini-tts with OPENAI_API_KEY. Without either, the phone
// uses its own speech synthesis.

import type { VoiceConfig } from "../store.ts";

export const TTS_INSTRUCTIONS =
	"Speak like a calm, competent colleague giving a quick update: clear, warm, brisk, no drama. Natural pauses between sentences.";

export interface TtsTarget {
	url: string;
	key?: string;
	model: string;
	voice: string;
	instructions?: string;
}

export function ttsTarget(cfg: VoiceConfig | undefined, env = process.env): TtsTarget | undefined {
	if (cfg?.ttsUrl) {
		return {
			url: `${cfg.ttsUrl.replace(/\/+$/, "")}/audio/speech`,
			key: cfg.ttsKey ?? undefined,
			model: cfg.ttsModel ?? "kokoro",
			voice: cfg.ttsVoice ?? "af_heart",
		};
	}
	if (env.OPENAI_API_KEY && cfg?.tts !== "off")
		return { url: "https://api.openai.com/v1/audio/speech", key: env.OPENAI_API_KEY, model: cfg?.ttsModel ?? "gpt-4o-mini-tts", voice: cfg?.ttsVoice ?? "marin", instructions: TTS_INSTRUCTIONS };
	return undefined;
}

/** Renders `text` to mp3. Throws `tts unavailable` when nothing is configured, so the phone speaks it itself. */
export async function synthesize(text: string, target: TtsTarget | undefined, fetchImpl: typeof fetch = fetch): Promise<{ audio: string; mime: string }> {
	if (!target) throw new Error("tts unavailable");
	const input = text.trim().slice(0, 4000);
	if (!input) throw new Error("nothing to say");
	const res = await fetchImpl(target.url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
		body: JSON.stringify({
			model: target.model,
			voice: target.voice,
			input,
			response_format: "mp3",
			...(target.instructions ? { instructions: target.instructions } : {}),
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`tts: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
	const audio = Buffer.from(await res.arrayBuffer());
	return { audio: audio.toString("base64"), mime: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
}
