// Voice personas: how pi sounds, never what it says. What is said and how much is fixed by the
// voice design (docs/voice-best-practices.md §4) and holds for every persona; a persona picks the
// voice, its delivery and pace, matched across the realtime model, the computer's speech and, as
// far as the phone allows, the phone's own voice.

import type { VoiceConfig } from "./config.ts";

export interface Persona {
	id: string;
	name: string;
	/** One line for the picker. */
	blurb: string;
	/** Realtime model voice, and the same voice for OpenAI speech (gpt-4o-mini-tts). */
	openai: string;
	/** Kokoro voice for a local speech server. */
	kokoro: string;
	/** Delivery only: timbre, warmth, pace. */
	delivery: string;
	/** Speech rate for the computer's and the phone's speech (1 = normal). */
	rate: number;
	/** Best effort for the phone's own voice, which exposes only names: preferred names, then pitch. */
	phone: { prefer: string; pitch: number };
}

export const PERSONAS: Persona[] = [
	{
		id: "marin",
		name: "Marin",
		blurb: "Feminine · warm and clear",
		openai: "marin",
		kokoro: "af_heart",
		delivery: "a warm, clear mid-range voice at an easy, even pace",
		rate: 1,
		phone: { prefer: "samantha|ava|allison|zoe|google us english", pitch: 1 },
	},
	{
		id: "cedar",
		name: "Cedar",
		blurb: "Masculine · low and calm",
		openai: "cedar",
		kokoro: "am_michael",
		delivery: "a low, calm, grounded voice; unhurried and steady",
		rate: 0.96,
		phone: { prefer: "evan|nathan|aaron|tom|alex|google uk english male", pitch: 0.9 },
	},
	{
		id: "coral",
		name: "Coral",
		blurb: "Feminine · bright and brisk",
		openai: "coral",
		kokoro: "af_bella",
		delivery: "a bright, lively voice at a brisk pace, light on its feet",
		rate: 1.06,
		phone: { prefer: "zoe|susan|karen|moira|google uk english female", pitch: 1.08 },
	},
	{
		id: "ash",
		name: "Ash",
		blurb: "Masculine · crisp and direct",
		openai: "ash",
		kokoro: "am_adam",
		delivery: "a crisp, even, matter-of-fact voice; clear consonants, no flourish",
		rate: 1,
		phone: { prefer: "daniel|tom|aaron|fred|google uk english male", pitch: 0.95 },
	},
];

export const DEFAULT_PERSONA = PERSONAS[0];

export function findPersona(id: unknown): Persona | undefined {
	return PERSONAS.find((p) => p.id === id);
}

export interface VoiceChoice {
	persona: Persona;
	/** Realtime model voice. */
	realtime: string;
	/** Voice for the computer's speech, given the configured server. */
	tts: string;
}

/**
 * The phone's pick wins; without one, `voice.realtimeVoice` / `voice.ttsVoice` in the config still
 * apply. A local server running a model other than Kokoro has its own voice names, so its
 * `ttsVoice` is always kept and the persona only sets delivery and pace there.
 */
export function chooseVoice(cfg: VoiceConfig | undefined, picked: unknown): VoiceChoice {
	const chosen = findPersona(picked);
	const persona = chosen ?? DEFAULT_PERSONA;
	const local = !!cfg?.ttsUrl;
	const kokoro = (cfg?.ttsModel ?? "kokoro") === "kokoro";
	const own = local ? persona.kokoro : persona.openai;
	return {
		persona,
		realtime: (!chosen && cfg?.realtimeVoice) || persona.openai,
		tts: local && !kokoro ? (cfg?.ttsVoice ?? DEFAULT_PERSONA.kokoro) : (!chosen && cfg?.ttsVoice) || own,
	};
}

/** What the phone needs to show the picker and to shape its own voice. */
export function personaList() {
	return PERSONAS.map(({ id, name, blurb, rate, phone }) => ({ id, name, blurb, rate, phone }));
}
