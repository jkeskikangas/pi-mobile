# pi-speech

Voice for [pi](https://pi.dev): dictation in the terminal that turns what you say into the prompt you meant, and the computer side of hands-free voice mode used by [pi-mobile](https://github.com/jkeskikangas/pi-mobile).

```bash
pi install npm:pi-speech
```

## Dictation

Press **alt+m** (or `/dictate`), talk, then press **Enter**. Esc cancels.

What lands in the editor is the message you meant, not a transcript: corrections applied ("null, no wait, undefined" → `undefined`), fillers gone, several asks turned into a list, and spoken names matched to real ones in your repo ("get user by ID in off dot ts" → `getUserById` in `src/auth.ts`). Anything ambiguous is noted as *unclear* instead of guessed. You review it and send.

- **Edit by voice.** With text in the editor, "make that a list" or "drop the second point" edits it. Names you correct before sending are remembered.
- `/dictate raw` (verbatim), `/dictate undo`, `/dictate send` or `/dictate review` (what happens after dictation), `/dictate status`.

## Recognition

- **macOS 26:** Apple's on-device SpeechAnalyzer. Free, private, live text while you talk. A small Swift helper compiles on first use (needs the Xcode command-line tools).
- **Anywhere else:** set `OPENAI_API_KEY` for `gpt-4o-transcribe`.
- The microphone is captured with `ffmpeg`. `PI_SPEECH_MIC` picks a device (`PI_SPEECH_FFMPEG` points at ffmpeg if it isn't on `PATH`).

The cleanup uses a fast model you already have in pi.

## Settings

`~/.pi/agent/pi-speech/config.json`: `stt` (`auto`/`apple`/`openai`), `locale` (e.g. `"fi-FI"`), `model` (`provider/id` for cleanup and spoken briefs), `afterDictation` (`review`/`send`), plus the voice-mode settings documented in pi-mobile. Settings from pi-mobile's older `"voice"` section are copied over on first run.

## With pi-mobile

pi-mobile depends on pi-speech and includes it, so you don't need both. If both are installed, dictation is registered once.

Design and verification: [docs/voice.md](https://github.com/jkeskikangas/pi-mobile/blob/main/docs/voice.md).
