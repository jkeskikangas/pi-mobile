# Voice for pi / pi-mobile: state of the art (2026-10-09)

The Codex claims come from reading the openai/codex source (shallow clone of `main` @ 4bc83aa, 2026-10-09). Paths are relative to `codex-rs/`. Everything else comes from the linked sources. **[verify]** marks a claim that needs a test on a real device or account.

---

## 1. OpenAI Codex voice

**Product surface**
- **ChatGPT desktop app (Codex/Work tabs).** Shipped 2026-07-23 and powered by GPT-Live, a full-duplex model. You can start tasks, interrupt mid-run, steer several agents, switch between them by voice ("let me talk to the task reviewing the tests" / "take me back"), and use a screen-context "appshot". Voice follows the same permission modes as typed input. It also works from Codex on iOS after pairing with a desktop host. https://learn.chatgpt.com/docs/features/voice · https://dreaming.press/posts/openai-codex-voice-control-conducting-agent-fleets.html
- **Codex CLI `/voice`.** Experimental since 0.155: live transcript you review before execution. Terminal fleet-voice demo 2026-10-05. https://www.chatgptaihub.com/codex-cli-0-155-experimental-voice-live-transcripts-microphone-workspace-files-review/ · https://metallab.ai/en/2026/10/openai-codex-cli-voice-agents-view
- **Dictation (STT only).** Codex Desktop uploads `audio/webm` to `POST https://chatgpt.com/backend-api/transcribe` with ChatGPT login. This endpoint sits behind Cloudflare bot challenges, which break non-browser clients. https://github.com/openai/codex/issues/21985 · TUI dictation was added and later removed: https://github.com/openai/codex/issues/14630

**Architecture (from source)**
- **Call creation with ChatGPT OAuth.** `POST https://chatgpt.com/backend-api/codex/realtime/calls` (query `?intent=quicksilver&architecture=avas` for v1/v3). The JSON body is `{sdp, session}`; the response is the SDP answer, with the call id in `Location`. With an API key, the same flow goes to `https://api.openai.com/v1/realtime/calls` as multipart (`sdp`, `session`). Source: `codex-api/src/endpoint/realtime_call.rs`. A sideband WebSocket on `api.openai.com/v1/realtime?call_id=…` carries control events (`core/src/realtime_conversation/sideband.rs`). Its fragility is a known bug: https://github.com/openai/codex/issues/35094.
  - So **ChatGPT-subscription OAuth can open realtime voice sessions with no API key**. However, the endpoint is undocumented and private, and Cloudflare/TLS fingerprinting is a risk.
- **Models.** `DEFAULT_FRAMELESS_REALTIME_MODEL = "gpt-live-1-codex"` and `DEFAULT_REALTIME_MODEL = "gpt-realtime-1.5"`. Input transcription uses `gpt-4o-mini-transcribe`. Voices include `cove`; voice selection is from PR #17176 (https://github.com/openai/codex/pull/17176).
- **Two-agent "intermediary + backend" design.** The voice model is a thin conversational layer with two tools:
  - `background_agent(prompt)`: "Do not rephrase the user's ask… pass along the user's own words." It starts a task, or steers the running task if one exists. It also queues "do X after this".
  - `remain_silent()`: "Call this when the best response is to say nothing… whenever acknowledging aloud would be distracting."

  Backend messages are injected as `[BACKEND] …` and user messages as `[USER] …`. `delegation.ack_filler` controls spoken "on it" fillers. (`codex-api/src/endpoint/realtime_websocket/methods_v2.rs`)
- **Budgets.** Startup context is about 5.3k tokens; spoken assistant output is capped at 1k tokens; backend handoff stream is flushed every 200 ms with an "…output truncated…" marker. (`core/src/realtime_conversation.rs`)
- **Turn-taking (v2).** `server_vad`, `silence_duration_ms: 500`, `interrupt_response: true` (barge-in), and `noise_reduction: near_field`. GPT-Live v3 is natively full duplex.
- **Voice prompt** (`prompts/templates/realtime/backend_prompt.md`). Key rules:
  - "Do not read out or recreate tables, diffs, plots, code blocks, structured data… by default"
  - "Briefly tell the user the key takeaway, status, or next step without repeating visible content"
  - Don't paraphrase the request or announce a plan
  - Progress updates only when "brief, grounded, and genuinely useful"
  - Verbosity and pacing preferences persist for the whole task
  - Present the system as one assistant (never mention the "backend")
  - Never refuse; delegate to the backend instead
- **Backend-side prompt** (`realtime_start.md`): "user text… may be unpunctuated or contain recognition errors"; "Keep responses concise and action-oriented." `realtime_end.md` switches back to normal chat expectations.

**GPT-Live-1 public API.** Released after ChatGPT. It is full duplex at **$0.05/min**, billed per second, with backend billed separately. Endpoint is `POST /v1/live/sessions`. **Client delegation** lets *any agent harness* act as the backend:
- The server sends `session.delegation.created` (metadata only; you rebuild the task from `session.input_transcript.delta`).
- The client replies with:
  - `session.thinking.append`: silent facts
  - `session.commentary.append`: spoken, paraphrased by the model, ≤500 tokens per append
  - `session.instructions.append`: can interrupt speech
- There is no auto-cancel on barge-in. The docs say to "confirm it succeeded before telling the user that the work was canceled".

The API path **requires an OpenAI project API key**. https://developers.openai.com/api/docs/models/gpt-live-1 · https://developers.openai.com/api/docs/guides/live · https://developers.openai.com/api/docs/guides/live-delegation.md

## 2. Claude Code `/voice` and Claude app voice

**CLI behaviour** (v2.1.69+, tap mode v2.1.116+). https://code.claude.com/docs/en/voice-dictation
- **Hold mode.** Hold `Space`, detected via key-repeat warmup ("keep holding…" → "listening…"). A modifier combo starts recording instantly. The cursor becomes a level meter.
- **Tap mode.** Tap to start, tap to send. The prompt auto-submits only if the transcript is ≥3 words, so stray taps don't send.
- **Auto-stop** after 15 s of silence or 2 min total.
- **Editing.** Interim text is shown *dimmed* and inserted at the cursor, so voice and typing mix. `Esc`/`Ctrl+C` cancels and restores the prior prompt. Optional `autoSubmit`.
- **Vocabulary.** "Tuned for coding vocabulary" (regex, OAuth, JSON, localhost); project name and git branch are added as hints automatically. 20 languages.
- **Access.** Transcription does not count toward usage limits. **Claude.ai login only** (no API key, Bedrock, or Vertex).

**Protocol** (reverse-engineered).
- `wss://…/api/ws/speech_to_text/voice_stream`. Newer builds use `api.anthropic.com` to avoid Cloudflare TLS-fingerprint blocks.
- Headers: `Authorization: Bearer <claude.ai OAuth>`, `x-app: cli`, and a `claude-cli/…` UA.
- Query: `encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=en`, plus optional `stt_provider=deepgram-nova3` and repeated `keyterms=`.
- Client sends binary 100 ms PCM frames, `{"type":"KeepAlive"}` every 8 s, and `CloseStream`.
- Server sends `TranscriptText` (interim), `TranscriptEndpoint`, and `TranscriptError`.
- Engine is Deepgram (Nova-3).

https://gist.github.com/byt3bl33d3r/061dad31daa37b1d81dfa8cc67d45168 · https://claude-wiki.com/voice-system.html · https://github.com/anthropics/claude-code/issues/37953

**Client techniques worth copying** (claude-wiki):
- Up to 50 keyterms: built-in coding terms + repo basename + branch name split on camel/kebab/snake case + recently accessed file names.
- **Audio is buffered locally while the socket connects**, which removes 1–2 s of perceived latency.
- **Silent-drop replay**: if the server returns zero transcripts, the whole buffer is re-sent on a new socket (about 1% of sessions).
- Finalization ends at whichever comes first: endpoint, 1.5 s with no data, or 5 s safety timeout.

**Claude app voice mode** (mobile, desktop, web). Hands-free or push-to-talk; push-to-talk is advised in noise. Since 2026-07-23 it runs on Opus, Sonnet, and Haiku (previously Haiku only) and can use connectors. https://support.claude.com/en/articles/11101966-use-voice-mode · https://claude.com/blog/think-through-hard-problems-in-voice-mode

## 3. Dictation tools (the bar for "intent cleanup")

**Wispr Flow**
- **Backtrack.** "Actually / scratch that / never mind", or simply restating, removes the false start. It uses the *whole utterance* as context and removes only *clear* self-corrections (it keeps "I actually enjoyed…"). https://docs.wisprflow.ai/articles/5373093536-how-do-i-use-smart-formatting-and-backtrack
- **Smart formatting.** Spoken enumerations become lists; punctuation is added; fillers are removed.
- **Command Mode.** A separate hotkey runs a spoken *instruction* on the selection or text box ("make this more concise", "reply saying…") instead of dictating. https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode
- **Context awareness.** Matches casing and spacing to the surrounding text (continuing mid-sentence → lowercase, leading space) and adapts style per app. https://docs.wisprflow.ai/articles/4678293671-feature-context-awareness
- **Variable recognition.** Function, class, and variable names are pulled from the active editor into STT context. In Cursor and Windsurf, spoken file names become `@file` tags. https://docs.wisprflow.ai/articles/8554805225-variable-recognition

**Aqua Voice.** Own model "Avalon", trained on human-computer speech (prompts, code), cloud only. **Superwhisper.** Local (Whisper/Parakeet) plus cloud, with custom "modes" (LLM post-prompts). **Willow.** YC-backed, $12/mo. None publish head-to-head benchmarks. https://www.digitalapplied.com/blog/ai-dictation-tools-2026-wispr-superwhisper-compared · https://aquavoice.com/vs/willow · https://www.getvoibe.com/resources/aqua-voice-vs-superwhisper/

**Takeaway: what the SOTA pipeline looks like**
1. Streaming STT, biased with context vocabulary.
2. An LLM cleanup pass covering fillers, backtrack, formatting, and identifier casing.
3. A separate explicit "command" channel for edits to existing text.

## 4. STT and TTS APIs (Oct 2026)

| Need | Best options | Notes |
|---|---|---|
| Streaming STT, OpenAI | **`gpt-live-transcribe`**, $0.017/min | `v1/realtime/transcription_sessions` (WebRTC or WS). Supports `prompt`, `keywords[]`, `languages[]`, and `delay: minimal…xhigh`. No server VAD: you do client VAD + `commit`. No timestamps or confidence. https://developers.openai.com/api/docs/guides/realtime-transcription.md |
| Post-turn STT | `gpt-transcribe`, `gpt-4o(-mini)-transcribe` | Uses prior turns as context; returns detected language. |
| Speech-to-speech | `gpt-realtime-2.1` / `-mini` (reasoning effort; better alphanumerics; p95 −25%) and `gpt-realtime-2` | $32 / $64 per 1M audio tokens in/out. https://developers.openai.com/api/docs/models/gpt-realtime-2 · https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896 |
| Full duplex + agent delegation | **GPT-Live-1**, $0.05/min | Fits "pi as the backend" best (§1). |
| STT with turn detection | **Deepgram Flux**, $0.0065/min | Built-in EOT with `eot_threshold`, `eager_eot_threshold` → `EagerEndOfTurn` / `TurnResumed` for speculative LLM start; 200–600 ms saved. https://developers.deepgram.com/docs/flux/configuration · https://developers.deepgram.com/docs/flux/voice-agent-eager-eot |
| STT, multilingual | ElevenLabs Scribe v2 Realtime | ~150 ms, 90+ languages. https://elevenlabs.io/realtime-speech-to-text |
| TTS, steerable | `gpt-4o-mini-tts-2025-12-15` | `instructions` for tone and pace. Reports in 2026 say instructions are sometimes ignored. https://developers.openai.com/api/docs/models/gpt-4o-mini-tts · https://community.openai.com/t/tts-no-longer-follows-instructions-parameter/1371743 |
| TTS, lowest latency | Cartesia Sonic 3.x (<90 ms TTFA) | ElevenLabs wins on voice quality and languages; Cartesia on latency and tail consistency. https://topaitracker.com/comparisons/2026-07-13-elevenlabs-vs-cartesia-text-to-speech-api-head-to-head/ |
| Google | Gemini 3.8 Live (native audio, barge-in, affective dialog, proactive audio) | Send 20–40 ms chunks; discard the playback buffer when `interrupted: true`. https://ai.google.dev/gemini-api/docs/live-api/capabilities · https://ai.google.dev/gemini-api/docs/live-api/best-practices |
| On-device (Mac or terminal side) | Apple SpeechAnalyzer (macOS/iOS 26), Parakeet TDT v2/v3, whisper.cpp | LibriSpeech clean: SpeechAnalyzer 1.98% WER, ~130 ms; whisper.cpp small.en 4.28%; Parakeet v2 2.01% / 3.40% (other). https://huggingface.co/datasets/researchaudio/apple-speechanalyzer-vs-whisper-cpp-mac · https://get-inscribe.com/blog/parakeet-moss-apple-speech-benchmark.html |
| Browser built-in | Web Speech API | Chrome has `processLocally` and an on-device quality enum (`command` / `dictation` / `conversation`), but Android lacks on-device support. iOS Safari has a 2026 bug where recognition dies after an `<audio>` element plays (fixed upstream). Not suitable as the primary path; acceptable as an offline fallback or for earcon-free TTS. https://chromestatus.com/feature/5136859632107520 · https://bugs.webkit.org/show_bug.cgi?id=321436 |

## 5. Voice UX research and guidelines

- **Cognitive load.** Speech is serial and transient, so it costs more working memory than a GUI. Minimise extraneous load. https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2019/08/how-to-reduce-cognitive-load-for-voice-design
- **Lists.** Limit spoken lists to 2–3 items (Google's "rule of three"). After hearing a list, listeners have about 8 s to decide. https://developer.amazon.com/en-US/alexa/alexa-haus/patterns-and-components/patterns-lists · https://design.google/library/rule-of-three
- **Grice / cooperative principle.** "Saying too much is as uncooperative as saying too little"; keep turns brief and relevant. https://developers.google.com/assistant/conversation-design/learn-about-conversation
- **Driving.** Voice interfaces are *not* free. Complex voice tasks measurably degrade driving, and cognitive workload persists after the interaction (Strayer et al.). NHTSA voice research found significant degradation for complex hands-free tasks. NHTSA's binding-style criteria exist only for visual-manual tasks: ≤2 s per glance, ≤12 s total eyes-off-road per task. Auditory-vocal guidelines (Phase 3) were never issued. https://link.springer.com/article/10.1186/s41235-016-0018-3 · https://www.nhtsa.gov/document/characteristics-voice-based-interfaces-vehicle-systems-and-their-effects-driving-0 · https://www.federalregister.gov/documents/2013/04/26/2013-09883/visual-manual-nhtsa-driver-distraction-guidelines-for-in-vehicle-electronic-devices
- **Earcons.** Most earcons do not interfere with understanding concurrent speech. Auditory icons are learned faster than abstract earcons. Hierarchical earcons let users identify their location in a menu with about 81% accuracy (Brewster). https://www.tandfonline.com/doi/full/10.1080/25742442.2023.2219201 · https://dl.acm.org/doi/pdf/10.1145/1518701.1518932 · https://eprints.gla.ac.uk/3247/1/using22_non_speech.pdf
- **Interruption cleanup.** Barge-in has to stop playback *client-side immediately* (Gemini and OpenAI guidance), and the transcript must be truncated to what was actually heard.

## 6. Mobile web constraints

- **iOS mic in the background.** WebKit mutes audio capture when backgrounded for "non-Safari applications" (changeset 268791). Safari *tabs* keep capturing with the red status bar (changeset 273069). Expect **no mic once a Home Screen PWA is backgrounded or locked**; a Safari tab with an active WebRTC call is more likely to survive **[verify on iOS 26/27]**. https://trac.webkit.org/changeset/268791/webkit · https://trac.webkit.org/changeset/273069/webkit
- **iOS background playback.**
  - Standalone PWAs have a long history of audio stopping in the background (bug 198277).
  - iOS 26 regression: `<audio>` fails after reopening a PWA (bug 295518).
  - iOS suspends the app once playback stops.
  - Lock-screen controls via Media Session exist since Safari 15; `togglemicrophone` and `setMicrophoneActive` since 18.4.
  - There is **no web background execution except push**.

  https://bugs.webkit.org/show_bug.cgi?id=198277 · https://bugs.webkit.org/show_bug.cgi?format=multiple&id=295518 · https://progressivewebapps.com/capabilities/media-and-system/ · https://progressivewebapps.com/platforms/
- **Wake Lock.** Works in iOS Home Screen apps from 18.4 and in Chrome from 84. It is released whenever the page is hidden, so re-acquire it on `visibilitychange`. There is no "system" wake lock.
- **Android Chrome.** Audible pages are exempt from freezing, so playback continues when locked. The media notification shows the PWA name.
- **Headsets / AirPods.** Stem presses map to Media Session `play`/`pause` (and next/previous) *only while an `<audio>` element is the active media session*. Web Audio alone is not reliably recognised. Use a looping or silent `<audio>` element plus `setActionHandler('pause', …)` as a push-to-talk toggle **[verify]**. https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setActionHandler
- **CarPlay.** No path for web apps. CarPlay apps need entitlement categories (audio, communication, navigation, etc.). The PWA's audio only routes through the car as phone audio. https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf

---

## Design principles and techniques that beat current SOTA

Codex voice is a strong conversational shell, but it is generic: it stays silent about code and leaves the details on screen. Claude Code voice is dictation only. pi-mobile can beat both by being **eyes-free-first**.

1. **Split the voice layer from the work layer, as Codex does.**
   - A thin voice agent with `delegate(user's own words)` and `remain_silent`. pi is the backend.
   - Pass the raw transcript to pi tagged "voice transcript; may contain recognition errors".
   - Never let the voice model paraphrase the request.
2. **Two output channels for every agent turn:** a *spoken brief* plus the screen or terminal artefact.
   - Generate the spoken brief with an explicit "speakable" contract: answer first, ≤2 sentences, ≤3 items, no code, no paths longer than the basename, numbers rounded ("about forty lines", "three of twelve tests failed").
   - Offer progressive disclosure: "Want the details?" / "Say 'read the diff' to hear it."
   - Codex only says "I won't read the diff". pi should *verbalise* it on request:
     - Per file: "auth.ts: replaced the token check with validateToken; 12 lines."
     - Identifiers spoken naturally (`getUserById` → "get user by id"), symbols named only when they carry meaning.
3. **Eyes-busy mode (driving, running, cycling)** as a first-class mode, not just a tone change.
   - Hard caps: one idea per utterance; nothing that requires looking.
   - No multi-choice above 2 options.
   - Destructive or irreversible actions (push, rm, deploy, force, sending messages) **need a verbal confirm that restates the object** ("Push 3 commits to main on origin? Say 'confirm push'.").
   - Auto-defer anything needing review: "I'll keep that for when you're at a screen."
   - Offer to queue the work instead of asking clarifying questions.
4. **Earcons instead of narration** for state:
   - Distinct short sounds for listening, delegated/working, needs-input, done-success, done-failure, and error.
   - A soft periodic "working" tick instead of spoken progress.
   - Speak only on state change or on request ("status?").
   - This matches Codex's "only genuinely useful progress", but without the cost of speech.
5. **Context-biased STT, built on Claude's approach:**
   - Keyterms from repo name, branch segments, recently touched files, *symbols in the diff and session*, and pi slash-commands and skill names.
   - Refresh per turn via `session.update` (gpt-live-transcribe supports `keywords` and `prompt` mid-session).
6. **Wispr-style cleanup pass** on the final transcript, using a cheap model or the main model's system prompt:
   - Backtrack ("no wait, I mean…").
   - Filler removal.
   - Identifier recovery ("get user by id" → `getUserById` when that symbol exists).
   - Spoken file names → `@path` mentions.
   - Keep the raw transcript available.
7. **Command vs dictation distinction:**
   - "pi, stop" / "cancel" / "undo that" / "status" / "switch to session X" are local intents with zero LLM latency.
   - Everything else is a prompt.
   - Barge-in during TTS must stop audio client-side within about 100 ms and truncate the spoken history to what was heard.
8. **Latency hiding:**
   - Buffer mic audio before the socket is ready (Claude).
   - Play an earcon instantly on end of turn.
   - Use speculative EOT (Flux `EagerEndOfTurn`) or server VAD at 500 ms. For dictation, a longer silence (~1–1.5 s) plus an explicit "send" word or tap.
   - Replay the buffer once on an empty transcript.
9. **Turn-taking policy per context:**
   - Push-to-talk (headset stem or a big on-screen button) for noisy, outdoor, or cycling use.
   - Open-mic VAD with barge-in for the car or kitchen.
   - ≥3-word guard against accidental sends.
10. **Persistent preferences** ("be more terse", "tell me every test result") hold until the task is done (Codex rule). Store them per session in pi.

## API recommendations given the user's subscriptions

- **Is an OpenAI API key required?**
  - *Officially, yes*: Realtime (`v1/realtime`), transcription (`v1/realtime/transcription_sessions`, `v1/audio/*`), GPT-Live (`v1/live/sessions`), and TTS all need an API key.
  - *Unofficially, no*: the ChatGPT/Codex OAuth token works against `https://chatgpt.com/backend-api/codex/realtime/calls`, which Codex itself uses for `gpt-live-1-codex` and `gpt-realtime-1.5`, and against `/backend-api/transcribe` for dictation.
  - These are private, undocumented, Cloudflare-guarded, may violate ToS for third-party clients, and can break without notice. Treat them as opt-in, "use at your own risk".
- **Claude subscription.** The claude.ai OAuth token works with `voice_stream` (Deepgram STT, does not count toward usage limits, supports keyterms). It is private and undocumented in the same way, and also Cloudflare- and TLS-fingerprint-sensitive.
- **Recommended stack:**
  1. **Default STT: run it in the terminal extension, not the phone.** The phone streams PCM to the pi extension over the existing pi-mobile WebSocket. The extension proxies to one of:
     - (a) `gpt-live-transcribe` with an API key (official, $0.017/min, keywords/prompt/delay), or
     - (b) the Claude `voice_stream` or Codex `realtime/calls` (transcription mode) using the stored OAuth tokens, opt-in.

     This keeps tokens off the phone and lets you add keyterms from the repo.
  2. **Conversational mode.** Best quality is GPT-Live-1 with **client delegation** (pi as backend):
     - The phone does WebRTC directly with OpenAI.
     - The extension mints the session server-side (API key), or, unofficially, POSTs the phone's SDP to `chatgpt.com/backend-api/codex/realtime/calls` with the ChatGPT token and returns the answer SDP. This is exactly Codex's flow.
     - Feed pi results via `session.commentary.append` (spoken) and `session.thinking.append` (silent).
  3. **Cheap or robust alternative:** a cascaded pipeline. STT (above) → pi (Claude or Codex via the subscription, as today) → a "speakable brief" step → TTS. For TTS, use `gpt-4o-mini-tts` with instructions, or Cartesia/ElevenLabs if a key exists; on-device `speechSynthesis` as the zero-cost fallback. A cascade gives full control over what is read aloud, which is the main differentiator.
  4. **Offline fallback:** Web Speech API (Chrome) or on-device Parakeet/SpeechAnalyzer on the Mac host.
- **Mobile reality check:**
  - iOS Home Screen PWAs will lose the mic, and probably audio, when locked. For driving or running, recommend a Safari tab with an active WebRTC/`getUserMedia` session, the screen kept on via Wake Lock, and a Media Session `<audio>` element for AirPods-stem push-to-talk **[verify]**.
  - Android Chrome works well with the screen locked while audio is playing.
  - CarPlay is not reachable; audio plays through the car only as phone audio.
  - A native shell (Capacitor) is the only robust path for background mic on iOS.
