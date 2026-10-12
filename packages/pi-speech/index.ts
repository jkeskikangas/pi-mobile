// pi-speech as a pi extension: voice input in the terminal (alt+m, /dictate) and voice mode (/voice, alt+v).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDictation } from "./src/dictation.ts";
import { registerVoiceMode } from "./src/voice-mode.ts";

export default function (pi: ExtensionAPI): void {
	registerDictation(pi);
	registerVoiceMode(pi);
}
