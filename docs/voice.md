# Voice: dictation at the desk, conversation on the move

Two different jobs, designed separately.

| | **Voice input** (desk) | **Voice mode** (phone, eyes and hands busy) |
|---|---|---|
| You | look at the screen, read everything | running, cycling, driving, cooking: cannot read or type |
| Speech is | a faster keyboard | the only channel, both ways |
| Output | a *written* prompt in the editor, for you to check | spoken words, as few as possible, plus the full written transcript for later |
| Failure to avoid | a verbatim transcript full of "um, no wait, the other file" | a model reading markdown, paths and diffs aloud |

## What the state of the art does (October 2026)

Research notes with sources: [voice-research.md](voice-research.md).

- **Codex voice** (ChatGPT app, Codex CLI `/voice`) puts a thin realtime voice model (GPT-Live / `gpt-realtime`) in front of the coding agent. The voice model has two tools, `background_agent(prompt)` ("pass along the user's own words") and `remain_silent()`; agent output is injected as `[BACKEND] …`. Its prompt forbids reading code, diffs and tables, and asks for progress updates only when "genuinely useful". It is a good conversational shell, but it assumes you can glance at the screen for anything detailed.
- **Claude Code `/voice`** is dictation only: hold-space push-to-talk, Deepgram Nova-3 streaming STT with key terms (project name, branch words, recent files), a dimmed live transcript inserted at the cursor, auto-stop on silence. The text is verbatim.
- **Dictation tools** (Wispr Flow, Superwhisper, Aqua) add an LLM cleanup pass: backtrack ("scratch that", restating), filler removal, list formatting, identifier recognition from the open editor, spoken file names as `@file` mentions.

None of them does both jobs well, and none treats "I am driving" as its own interaction design.

## Design principles

### Voice input

1. **Intent, not transcript.** Speech is high-bandwidth but redundant and ambiguous. The output is the prompt you would have typed: self-corrections applied, filler and restarts gone, the request ordered (goal, constraints, steps), every concrete detail you said kept.
2. **Ground the words in the workspace.** Spoken identifiers are matched to real ones: `get user by id` → `getUserById`, "orthodotts" → `auth.ts`. The vocabulary comes from the repo (tracked file names, the current branch) and the session (identifiers and paths in recent messages). The same vocabulary biases the recogniser.
3. **Surface ambiguity, never paper over it.** When something you said has two readings, the distilled prompt keeps your words and adds a short `(unclear: …)` note, instead of silently picking one.
4. **You stay the editor.** The distilled prompt lands in the editor, not in the model. One key swaps to the raw transcript, one key cancels and restores what you had typed.
5. **Stream what you say while you say it.** A live (dim) transcript and level meter show the mic is hearing you. Distillation runs once, when you stop. On the phone, hold the mic and let go (walkie-talkie), or tap to start and stop; a waveform shows it hears you.
6. **Edit by voice.** With text already in the editor, dictating "make that a list", "drop the second point" or "change X to Y" edits it instead of appending the words.
7. **Learn from corrections.** When you fix a distilled dictation before sending it, the replaced names ("get user" → `fetchUser`) go into a personal dictionary (`voice-dictionary.json` in the state dir) that biases recognition and distillation from then on.
8. **Free and private by default.** On a Mac the recogniser is Apple's on-device SpeechAnalyzer (macOS 26): no account, no audio leaves the machine, about 2% WER on clean speech, contextual-string biasing. An OpenAI API key (`OPENAI_API_KEY`) switches to `gpt-4o-transcribe` where SpeechAnalyzer is unavailable. Distillation uses a model you already have in pi.

### Voice mode

1. **Talk about intent, not code.** Nobody discusses variable names on a run. Voice conversations are about behaviour, architecture, decisions, trade-offs, risks and what is left. The voice never says identifiers, file names, paths, commands, test names or tool names unless asked; it names parts of the system by what they are ("the login flow", "the phone app"). The agent is told the same, and maps what the user describes onto the code itself.
2. **Tool activity is not news.** Reads, searches, edits and routine commands stay silent, and routine failures the agent recovers from are its own business. Only *significant* actions reach the ear: anything touching production systems or data, deployments, shared history (push, force, reset), deletions, external services or money. When one fails, the phone plays a failure tone and the voice says what kind of action failed, while pi keeps working.
3. **Two output channels for every run.** The agent writes as usual: the transcript keeps the full written answer for when you're back at a screen. What you *hear* is a spoken brief written for the ear: the outcome first, one idea per sentence, numbers rounded, no code, no symbols, no markdown. The report behind it is organised by area of the system and significant actions, not by file or tool.
4. **Say less, offer more.** A brief ends, when there is more, with one offer at the same level ("want to hear why the tests still fail?"). Details are answered on request at the level of behaviour; file names only when you ask "which files".
5. **Sounds for state, words for news.** Short earcons mark listening, heard-you, working (a soft tick every few seconds), needs-you, done and failed. Speech is reserved for things that change what you do next. "Status?" gets a one-sentence answer at any time from local state, without waking the agent: how long pi has worked, what kind of thing it is doing ("running the tests", never which file), and the last thing it said it was doing.
6. **Commands are instant.** "Stop", "cancel", "repeat", "status", "shorter", "go on", "yes/no", "option two" are recognised locally with no model round trip.
7. **Questions are answerable by voice.** Any extension dialog (`confirm`, `select`, `input`) that pi raises is read out (two options at a time) and answered by voice. Permission gates are covered too. A question from another session is announced, and "switch to …" moves there.
8. **Destructive actions need an explicit spoken confirmation that names the action** ("push three commits to main? say *yes, push*"). A plain "yeah" from a noisy street is not consent.
9. **Defer what needs eyes.** In eyes-busy contexts the agent is told the user cannot read: it avoids asking for visual review, and the voice says the diff is waiting at a screen.
10. **Barge-in is a first-class signal.** Speaking while pi talks stops the audio immediately (echo cancellation keeps the speaker from triggering it), and what you say next is a new turn.
11. **Turn-taking fits the context.** Open mic with semantic end-of-turn detection in the car or kitchen; tap-to-talk (a screen-sized target, or a headset button where the browser allows it) when it's noisy, windy or you're cycling. In basic voice a trailing "and…", "um" or "wait" keeps the floor open.
12. **Never announce, just act.** The voice does not say "let me check"; it calls pi silently and the working tick carries the wait. The phone enforces it: when the voice hands a request to pi, whatever it was about to say with it is cut. Preferences you state ("be terser") stick until you change them.
13. **Soft barge-in.** About half of the sounds that trip a voice detector while an assistant talks are backchannels, coughs or echo. When you make a sound over pi, its voice drops to 20% within ~200 ms; it stops only after ~800 ms of voiced speech (Hume's default) or when your words turn out to mean something ("stop", "no"). "Mm-hmm" and coughs leave pi talking. Nothing you say is dropped unheard: short sounds are transcribed and judged by their words. (The realtime server clears the assistant's audio on any speech regardless of `interrupt_response`, a known API bug, so while pi speaks the phone does turn-taking itself and hands it back to the server's semantic VAD when pi is silent.)
14. **Ask once, with an undo window.** pi's permission dialogs for irreversible actions normally need the action named ("yes, deploy"). But if *you* just asked for exactly that action and target, the phone (not the model) recognises it from what it heard you say, the voice says "Deploying to production, say stop to cancel", and the dialog is confirmed after four seconds unless you say stop or tap Cancel. One spoken sentence instead of being asked three times.
15. **pi's own voice is never consent.** Speech heard while pi was talking that repeats pi's words ("say yes, deploy to confirm") is marked as echo: it cannot answer a destructive question or count as an earlier request.
16. **Help is a question away.** "What can I say?" gets a two-sentence answer; first-time users get a one-sentence spoken intro and rotating example hints that disappear after a few sessions.

## Architecture

```
terminal (desk)                      phone (voice mode / composer mic)
 ffmpeg mic → PCM ─┐                  getUserMedia ──WebRTC──▶ OpenAI realtime (gpt-realtime via your Codex sign-in or an API key)
                   ▼                     │  data channel: transcripts, tool calls ↕
        STT (Apple on-device | OpenAI)   │  tool calls → sealed RPC → hub → bridge → pi
                   ▼                     │  pi events  → SSE → phone → injected as [PI] context
        distill (pi model) → editor      └─ fallback: MediaRecorder → bridge STT → pi → brief → speechSynthesis
```

Everything the phone and pi exchange stays end-to-end encrypted through the hub. The realtime session is set up by the bridge (it holds the credentials): the phone sends its WebRTC offer through the sealed RPC, the bridge posts it to the realtime endpoint and returns the answer. Audio then flows directly between the phone and OpenAI; no OAuth token ever reaches the phone.

### Modules

| File | Responsibility |
|---|---|
| `src/voice/vocab.ts` | Workspace vocabulary: tracked files, branch words, declared code symbols (`git grep`), names in recent session messages; spoken forms; trigram-indexed fuzzy matching of what was heard to real names. |
| `src/voice/distill.ts` | The intent-distillation prompt and its output parsing; heuristic fallback (fillers, "scratch that", near-exact names, flags mid-sentence corrections) when no model is reachable. |
| `src/voice/speech.ts` | Writing for the ear: run digest by area and significant action, the spoken-brief prompt, `speakable()`, activity descriptions, significance rules, the agent's voice note. |
| `src/voice/host.ts` | The bridge's voice requests: transcribe, distill, brief, details, realtime call setup, listening state. |
| `src/voice/stt.ts` | STT providers: Apple SpeechAnalyzer helper (compiled once into the state dir), OpenAI transcription; selection. |
| `src/voice/apple-stt.swift` | On-device recogniser: file or streaming stdin PCM, contextual strings, JSON-lines partials. |
| `src/voice/mic.ts` | Microphone capture via ffmpeg (avfoundation / pulse / dshow, or a file) as 16 kHz PCM with a level meter. |
| `src/voice/model.ts` | Fast-model candidates the user has credentials for; one completion, skipping models that fail. |
| `src/voice/realtime.ts` | Realtime session config (voice-layer instructions and tools) and the SDP relay to OpenAI. |
| `src/voice/dictation.ts` | Terminal voice input: `/voice`, alt+m, live widget, review flow. |
| `web/voice.js` | Composer dictation and phone voice mode: realtime client, basic-voice cascade, earcons, wake lock, media session, dialogs by voice. |
| `web/voice-core.js` | Pure logic shared with tests: voice commands and help, dialog answers, the undo-window rule, backchannels and echo, significance, VAD, speech chunking, earcon specs. |
| `src/voice/dictionary.ts` | The personal dictionary: corrections learned from edits to distilled dictations. |
| `src/voice/personas.ts` | Voice personas: voice names per engine, delivery and pace; the phone's pick versus the config's voices. |
| `src/voice/tts.ts` | Optional speech from the computer for basic voice (any OpenAI-compatible `/v1/audio/speech`). |

### Bridge requests added

| Request | Payload → result |
|---|---|
| `transcribe` | `{audio: base64, mime, distill?, draft?}` → `{raw, text, editor, unclear[], provider, by}` |
| `distill` | `{raw, draft?}` → `{raw, text, editor, unclear[], by}` |
| `brief` | `{mode}` → `{speech, more[], report, by}`: spoken brief of the latest run plus the report for follow-ups |
| `details` | `{topic, mode}` → `{speech}` |
| `voiceStatus` | `{}` → `{speech, status, elapsedMs, tools, prompts}` |
| `voiceSession` | `{sdp, mode, persona?}` → `{sdp, model, provider}`: realtime call set up with the voice-layer config |
| `voices` | `{}` → `{personas: [{id, name, blurb, rate, phone}], sample}`: the voice picker; `sample` says whether the computer can play one |
| `speak` | `{text, persona?}` → `{audio: base64, mime}` from `voice.ttsUrl` or OpenAI TTS; `tts unavailable` means the phone speaks itself |
| `voiceState` | `{on, mode}` → `{ok}`: the agent is told its user is listening (expires after 150 s without a refresh) |

## Platform limits (verified against WebKit/Chromium sources, see research notes)

- Browsers give `getUserMedia` only to secure contexts: phone voice needs the HTTPS address, which `/remote` sets up with Tailscale Serve (or `http://127.0.0.1` on the computer).
- iOS stops capturing the mic when a Home Screen PWA goes to the background or locks; a Safari tab with an active capture keeps it longer. Voice mode keeps the screen awake (Wake Lock) and tells you when iOS took the mic away. Android Chrome exempts audible pages from freezing; verify on the device before relying on it.
- CarPlay has no path for web apps; the phone's audio plays through the car as usual.
- **A native iPhone app** would lift the hardest limits for voice mode: a background audio session keeps the mic with the screen locked (phone in a pocket), Apple's voice-processing I/O gives stronger echo cancellation for speakerphone barge-in, headset buttons work reliably, and Siri or the Action button can start a conversation, with status on the lock screen. CarPlay would still need an Apple entitlement (unverified for this kind of app). A web view wrapper is not enough, because it has the same capture limits. The suggested shape: keep the web app, and add a small native app for voice mode only that reuses the same pairing, bridge requests and voice design. Not built.
- The ChatGPT-sign-in realtime endpoint is the one Codex uses; it is undocumented and may change. With `OPENAI_API_KEY` set, the official `api.openai.com/v1/realtime/calls` endpoint is used instead. Without either, voice mode runs the cascaded pipeline (host STT + spoken brief + the phone's own speech synthesis).

### Other projects looked at

[Voicebox](https://github.com/jamiepine/voicebox) (local voice studio: TTS engines with cloning, Whisper dictation with LLM cleanup, an OpenAI-compatible `/v1/audio/speech`). It has no VAD, barge-in or true streaming, so nothing for the realtime path. Taken from it: collapsing recogniser repetition loops before distillation, the spoken-path rule ("src slash components" → `src/components`), and the OpenAI-compatible speech endpoint as an optional voice for basic mode (`voice.ttsUrl`), so Voicebox or Kokoro can speak on the phone. Left out: its batch Whisper STT (on-device SpeechAnalyzer and realtime transcription are better here), cloning, and speaking on the host's speakers.

## Verification

Unit and integration tests (`npm test`) cover vocabulary matching (including a 5,000-file repo under the time budget), distillation prompts and fallbacks, writing for the ear, significance rules, the realtime session and call relay, the voice host, the phone's voice logic (`web/voice-core.js`: commands, dialog answers with destructive confirmation, VAD, chunking), and the bridge's voice requests over the real encrypted hub protocol.

End to end, against the real services (October 2026, macOS 26, ChatGPT sign-in, no API key):

```bash
# isolated agent dir with your auth, a demo repo, pi with the extension
mkdir -p /tmp/voice-demo && git -C /tmp/voice-demo init   # add a small source file to talk about
mkdir -p /tmp/piagent/pi-mobile && cp ~/.pi/agent/auth.json /tmp/piagent/
echo '{"port":7999,"expose":"local","enabled":true}' > /tmp/piagent/pi-mobile/config.json
tmux new -d -s pivoice -c /tmp/voice-demo "PI_CODING_AGENT_DIR=/tmp/piagent pi -e $PWD/src/index.ts"
URL=$(PI_CODING_AGENT_DIR=/tmp/piagent node --experimental-strip-types test/e2e/pair.ts)
node test/e2e/browser.mjs dictate "$URL" speech.wav     # composer dictation
node test/e2e/browser.mjs voice "$URL" question.wav 60  # voice mode
# terminal dictation without a live mic:
PI_MOBILE_MIC=file:speech.wav pi -e ./src/index.ts      # then alt+m … Enter
```

Observed:

| Path | Spoken | Result |
|---|---|---|
| Terminal and phone dictation (Apple on-device STT → distillation) | "Um, so in auth dot ts, make get user by ID return null instead of throwing, no wait, return undefined, and update the validate token check to require twenty characters." Recognised as "So in off.ts, make get user by ID return null…" | "In `src/auth.ts`, make `getUserById` return `undefined` instead of throwing, and update `validateToken` to require 20 characters." 2.5–3.5 s after the mic stops. The terminal merges it with text already typed. |
| Voice mode, realtime (`gpt-realtime-2` over WebRTC, call opened with the ChatGPT sign-in) | "What does the get user by ID function in auth dot ts do when the user is missing? Just tell me, don't change anything." | `ask_pi` with the user's words; pi read the code; the voice said "It throws an error that says 'no user' followed by the requested ID." about 5 s after the question ended, with no filler before it. |
| Voice mode, basic (realtime off: phone VAD → host STT → distil → pi → brief → speech synthesis) | same | "When the user is missing, the authentication lookup throws an error saying 'no user' followed by the requested ID." about 5 s after the question ended. |
| Basic voice with speech from the computer (`voice.ttsUrl` → an OpenAI-compatible test server) | same question | The brief was rendered by the server (`POST /v1/audio/speech`, model `kokoro`, voice `af_heart`) and played on the phone; the voice went back to listening when the audio ended. |
| Answering a permission dialog by voice (`test/e2e/deploy-ext.ts`) | "Please deploy the app to production." … "Yeah." … "Yes, deploy." | pi called the deploy tool; its confirm dialog was read out: "This will deploy the current main branch to production. Say 'yes, deploy' to confirm, or say 'no' to cancel." On "Yeah" the voice model tried `answer_question("yes")`; the phone refused it (action not named) and the voice asked again naming the target. "Yes, deploy" confirmed it (the tool logged `confirm=true`); then "Production deployment is complete and the app is live." |

Found and fixed by these runs: a transcription prompt carrying project names was returned *as the transcript* for audio clipped at the start, and the voice turned it into a task nobody asked for. The realtime session now sends no transcription prompt, the voice is told to ask for a repeat rather than guess, and the OpenAI file transcriber discards a leaked prompt. Also: "low" semantic-VAD eagerness never closed the turn on the test audio (now "auto", with `turnDetection: "server"` available), the voice announced itself ("let me check…") before tools (now forbidden), and the voice model was a model the account could not use (candidates now fall through).

Turn-taking, with a scriptable microphone (`test/e2e/turns.mjs`: clips played into a WebAudio stream at chosen moments over a quiet noise floor):

| Measure | Result |
|---|---|
| "Mm-hmm" while pi talks | ignored; pi finished its sentence at full volume (0 cancels) |
| You start talking over pi → pi's voice ducks | 177 ms |
| You keep talking → pi stops | 1.7 s for "Wait, stop. Is that safe…" (the clip pauses after "stop"); ducked meanwhile |
| Your interrupting turn | committed and answered |
| End of question → handed to pi | 1.1–1.2 s; a tone confirms at once |
| End of question → pi's spoken answer (pi read the code meanwhile) | 4.5–6 s |
| "Stop." during the undo window, spoken over pi's "say stop to cancel" | transcribed, window cancelled, dialog answered no (`confirm=false`), "Cancelled" |
| "Please deploy the app to production" with a deploy dialog | "Deploy to production, say stop to cancel", confirmed after 4 s (`confirm=true`), "Deployed to production successfully" |

These runs found and fixed: the server cutting pi's audio on any sound (moved turn-taking to the phone while pi speaks), a short "stop" over pi being discarded as a backchannel (short sounds are now transcribed before judging), and the undo window depending on the model's judgement (now decided on the phone).

Not verifiable here, to check on real devices: microphone behaviour with the iPhone screen locked, the headset play/pause button as tap-to-talk (Media Session), Android Chrome with the screen off, and echo cancellation against the phone speaker for barge-in.
