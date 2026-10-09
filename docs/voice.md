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
5. **Stream what you say while you say it.** A live (dim) transcript and level meter show the mic is hearing you. Distillation runs once, when you stop.
6. **Free and private by default.** On a Mac the recogniser is Apple's on-device SpeechAnalyzer (macOS 26): no account, no audio leaves the machine, about 2% WER on clean speech, contextual-string biasing. An OpenAI API key (`OPENAI_API_KEY`) switches to `gpt-4o-transcribe` where SpeechAnalyzer is unavailable. Distillation uses a model you already have in pi.

### Voice mode

1. **Two output channels for every run.** The agent writes as usual: the transcript keeps the full written answer for when you're back at a screen. What you *hear* is a spoken brief written for the ear: the answer first, one idea per sentence, at most three items, numbers rounded ("three of twelve tests fail"), file names by basename, no code, no symbols, no markdown.
2. **Say less, offer more.** Every brief ends, when there is more, with one offer ("want the failing test names?"). Details are spoken on request, verbalised for the ear (a diff becomes "auth.ts: the token check now calls validateToken, twelve lines").
3. **Sounds for state, words for news.** Short earcons mark listening, heard-you, working (a soft tick every few seconds), needs-you, done and failed. Speech is reserved for things that change what you do next. "Status?" gets a one-sentence answer at any time, from local state, without waking the agent.
4. **Commands are instant.** "Stop", "cancel", "repeat", "status", "shorter", "go on", "yes/no", "option two" are recognised locally with no model round trip.
5. **Questions are answerable by voice.** Any extension dialog (`confirm`, `select`, `input`) that pi raises is read out (two options at a time) and answered by voice. Permission gates are covered too.
6. **Destructive actions need an explicit spoken confirmation that names the object** ("push three commits to main? say *confirm push*"). A plain "yeah" from a noisy street is not consent.
7. **Defer what needs eyes.** In eyes-busy contexts the agent is told the user cannot read: it avoids asking for visual review, prefers queuing work over asking clarifying questions, and the voice layer offers "I'll leave the diff for when you're at a screen."
8. **Barge-in is a first-class signal.** Speaking while pi talks stops the audio immediately (echo cancellation keeps the speaker from triggering it), and what you say next is a new turn.
9. **Turn-taking fits the context.** Open mic with voice-activity detection in the car or kitchen; tap-to-talk (big screen target, or a headset button where the browser allows it) when it's noisy, windy or you're cycling. Trailing "and…", "um" or "wait" keeps the floor open.
10. **Preferences stick.** "Be terser", "tell me every test result" last until you change them.

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
| `src/voice/vocab.ts` | Workspace vocabulary: tracked files, branch words, identifiers and paths in recent session messages, spoken forms of identifiers. |
| `src/voice/distill.ts` | The intent-distillation prompt and its output parsing; heuristic fallback (backtrack and filler removal, identifier recovery) when no model is reachable. |
| `src/voice/speech.ts` | Writing for the ear: the spoken-brief prompt; a deterministic `speakable()` that strips markdown, code and paths and verbalises identifiers and numbers; local voice-command recognition. |
| `src/voice/stt.ts` | STT providers: Apple SpeechAnalyzer helper (compiled once into the state dir), OpenAI transcription; selection and auto-detection. |
| `src/voice/apple-stt.swift` | On-device recogniser: file or streaming stdin PCM, contextual strings, JSON-lines partials. |
| `src/voice/mic.ts` | Microphone capture via ffmpeg (avfoundation / pulse / alsa) as 16 kHz PCM with a level meter. |
| `src/voice/model.ts` | Picks a fast model the user already has credentials for, runs one completion. |
| `src/voice/realtime.ts` | Realtime session config (voice-layer instructions and tools) and the SDP relay to OpenAI. |
| `src/voice/dictation.ts` | Terminal voice input: `/voice` and a shortcut, live widget, review flow. |
| `web/voice.js` | Phone voice mode: realtime client, cascaded fallback, earcons, wake lock, intents, dialogs by voice. |
| `web/voice-core.js` | Pure logic shared with tests: voice commands, VAD state machine, ear formatting of events. |

### Bridge requests added

| Request | Payload → result |
|---|---|
| `transcribe` | `{audio: base64, mime, distill?: boolean}` → `{raw, text, notes[], provider}` (STT on the host, then distillation) |
| `distill` | `{raw}` → `{text, notes[]}` |
| `brief` | `{since?}` → `{speech, more?}`: the spoken brief of the latest run |
| `details` | `{topic}` → `{speech}`: on-demand verbalised detail (diff, failing tests, last message) |
| `voiceSession` | `{sdp, eyesBusy}` → `{sdp, model, provider}`: realtime call set up with the voice-layer config |
| `voiceState` | `{on, eyesBusy}` → `{ok}`: tells the agent the user is listening by voice |

## Platform limits (verified against WebKit/Chromium sources, see research notes)

- iOS stops capturing the mic when a Home Screen PWA goes to the background or locks; a Safari tab with an active capture keeps it longer. Voice mode keeps the screen awake (Wake Lock) and tells you when iOS took the mic away. Android Chrome keeps working with the screen locked while audio is active.
- CarPlay has no path for web apps; the phone's audio plays through the car as usual.
- The ChatGPT-sign-in realtime endpoint is the one Codex uses; it is undocumented and may change. With `OPENAI_API_KEY` set, the official `api.openai.com/v1/realtime/calls` endpoint is used instead. Without either, voice mode runs the cascaded pipeline (host STT + spoken brief + the phone's own speech synthesis).
