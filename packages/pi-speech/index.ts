// pi-speech as a pi extension: voice input in the terminal (alt+m, /dictate).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDictation } from "./src/dictation.ts";

export default function (pi: ExtensionAPI): void {
	registerDictation(pi);
}
