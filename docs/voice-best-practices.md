# Voice: best practices and design principles, with references

The practices the voice features are built on, where each lives in the code, why, and the evidence behind it. The design itself is in [voice.md](voice.md); the research notes are [voice-research.md](voice-research.md) (round 1: products, APIs, VUI research, platform limits) and [voice-research-2.md](voice-research-2.md) (round 2: turn-taking, voice UX, audio plumbing, safety). UI rules shared with the rest of the app are in [design-principles.md](design-principles.md) and [ui.md](ui.md).

**Evidence labels.** *Source*: an external reference (linked). *Measured*: measured by our end-to-end runs against the real services (`test/e2e/`, results in voice.md → Verification). *Observed*: found while testing here, without an external reference. *Pattern*: a common interaction pattern without one canonical source. *Unverified*: needs a real device or comes from a single vendor.

---

## 1. The two jobs are different

| | Voice input (desk) | Voice mode (eyes and hands busy) |
|---|---|---|
| Output | a *written* prompt for you to review | *speech*, as little as possible, plus the full written transcript for later |
| Speech is | a faster keyboard | the only channel, both ways |

**Practice:** design and tune them separately; never reuse dictation output as speech or speech-tuned text as a prompt.
**Why:** dictation optimises for completeness and precision (you will read it); voice mode optimises for working memory (you can't re-read it). Speech is serial and transient, so it costs more working memory than a screen.
**Evidence:** *Source*: Amazon, [How to reduce cognitive load for voice design](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2019/08/how-to-reduce-cognitive-load-for-voice-design). The split mirrors today's products: Claude Code `/voice` is dictation only ([docs](https://code.claude.com/docs/en/voice-dictation)); Codex voice is a conversational layer over the agent (voice-research.md §1).

---

## 2. Voice input (dictation)

### 2.1 Distil intent, don't transcribe
**What:** a model rewrites the dictation into the message you meant: final intent after self-corrections ("null, no wait, undefined" → `undefined`), fillers and restarts gone, several asks turned into a goal plus a short list, every concrete detail kept, nothing added. `src/voice/distill.ts` (`DISTILL_SYSTEM`).
**Why:** speech has more bandwidth than typing but is redundant and self-correcting; a verbatim transcript is a worse prompt than what you would have typed.
**Evidence:** *Source*: Wispr Flow backtrack and smart formatting ([docs](https://docs.wisprflow.ai/articles/5373093536-how-do-i-use-smart-formatting-and-backtrack)); Superwhisper post-processing "modes" (voice-research.md §3). *Measured*: "So in off.ts, make get user by ID return null instead of throwing. No wait, return undefined…" → "In `src/auth.ts`, make `getUserById` return `undefined` instead of throwing…" in 2.5–3.5 s.

### 2.2 Ground names in the workspace, before and after recognition
**What:** tracked files, declared symbols (`git grep` of declarations, compound names first), names from the recent conversation and branch words become (a) recogniser hints and (b) a candidate list in the distillation prompt, with trigram-indexed fuzzy matches ("orthodotts" → `auth.ts`). A name the dictation uses that does not exist is treated as misheard. `src/voice/vocab.ts`, `distill.ts`.
**Why:** recognisers mangle code names; matching by sound against what actually exists fixes most of it, and biasing the recogniser prevents some of it.
**Evidence:** *Source*: Claude Code key terms from project name, branch and recent files ([voice system notes](https://claude-wiki.com/voice-system.html)); Wispr Flow variable recognition ([docs](https://docs.wisprflow.ai/articles/8554805225-variable-recognition)); Apple SpeechAnalyzer contextual strings. *Measured*: "off.ts" (no such file) → `src/auth.ts`; "validate token check" → `validateToken`. Matching a 5,000-file repo takes ~0.2 s (unit test).

### 2.3 Surface ambiguity instead of guessing
**What:** genuinely ambiguous points are kept in your words and listed under *Unclear*; trivia is not flagged. `DISTILL_SYSTEM` rule 6.
**Why:** a confident wrong guess costs more than a question you can delete.
**Evidence:** *Source*: OpenAI GPT-Live prompting guide recommends targeted clarification of just the unclear part ([guide](https://developers.openai.com/api/docs/guides/live-prompting)). *Measured*: a dictation cut off mid-sentence produced "Unclear: What change should be made to `validateToken`?" instead of an invented requirement.

### 2.4 You stay the editor
**What:** the result goes to the editor, never straight to the model (opt-in `/voice send`); raw transcript and undo are one step away (`/voice raw|undo`, phone chips). `src/voice/dictation.ts`, `web/voice.js`.
**Why:** distillation can be wrong; review costs a glance at a desk.
**Evidence:** *Source*: Codex CLI `/voice` shows a live transcript you review before running ([report](https://www.chatgptaihub.com/codex-cli-0-155-experimental-voice-live-transcripts-microphone-workspace-files-review/)); Claude Code auto-submits only with 3+ words and optionally ([docs](https://code.claude.com/docs/en/voice-dictation)).

### 2.5 Show that it hears you, live
**What:** live partial transcript and a level meter in the terminal; a waveform and timer on the phone.
**Why:** silence while recording makes people stop and check; feedback keeps them talking.
**Evidence:** *Source*: Claude Code's dimmed live transcript and mic level meter ([docs](https://code.claude.com/docs/en/voice-dictation)).

### 2.6 Hold to talk, or tap to toggle
**What:** phone: hold the mic and release (walkie-talkie), a quick tap toggles; terminal: alt+m toggles, Enter finishes, Esc cancels (terminals rarely report key release).
**Why:** holding is the fastest for short asks; toggling suits long thoughts.
**Evidence:** *Source*: Claude Code hold and tap modes, and its key-repeat workaround for hold detection ([docs](https://code.claude.com/docs/en/voice-dictation)).

### 2.7 Edit by voice
**What:** with text already in the editor, "make that a list", "drop the second point" or "change X to Y" edits it instead of appending. `DISTILL_SYSTEM` rule 8.
**Evidence:** *Source*: Wispr Flow Command Mode ([docs](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)); Typeless and Shaberu inline commands (voice-research-2.md §6).

### 2.8 Learn from corrections
**What:** names you replace in a distilled dictation before sending ("get user" → `fetchUser`) go into a personal dictionary (`voice-dictionary.json`) that feeds recogniser hints and the prompt. `src/voice/dictionary.ts`.
**Evidence:** *Source*: Wispr Flow adds corrected spellings to the personal dictionary automatically ([features](https://wisprflow.ai/features)).

### 2.9 Private and free by default; prewarm
**What:** on macOS 26 recognition is Apple's on-device SpeechAnalyzer through a small Swift helper, compiled and its model installed in the background at startup; `OPENAI_API_KEY` switches to `gpt-4o-transcribe`. Distillation uses a fast model you already have, skipping models your account can't use. `src/voice/stt.ts`, `apple-stt.swift`, `model.ts`.
**Evidence:** *Source*: SpeechAnalyzer ~1.98% WER on LibriSpeech clean at ~130 ms ([benchmark](https://huggingface.co/datasets/researchaudio/apple-speechanalyzer-vs-whisper-cpp-mac), [comparison](https://get-inscribe.com/blog/parakeet-moss-apple-speech-benchmark.html)). *Observed*: the first-ever use compiles the helper (~6 s); prewarming removes that wait.

### 2.10 Distrust recogniser artefacts
**What:** phrases repeated 4+ times in a row are collapsed before distillation; a transcriber that returns its own vocabulary prompt is treated as "no speech"; the realtime session sends no transcription prompt at all.
**Evidence:** *Source*: Voicebox strips Whisper's looping hallucinations before LLM cleanup (`backend/services/refinement.py`, [repo](https://github.com/jamiepine/voicebox)). *Observed*: on clipped audio `gpt-4o-mini-transcribe` returned our prompt ("Software development. Names: …") as the transcript, and the voice model turned it into a task nobody asked for.

---

## 3. Voice mode: architecture

### 3.1 A voice layer in front of the agent, relaying your own words
**What:** a realtime speech model talks with you and delegates with `ask_pi(request)` in your words, cleaned of fillers but not rephrased; pi does the work. Messages from pi arrive as `[PI] …` context, never as instructions. `src/voice/realtime.ts`.
**Evidence:** *Source*: Codex's realtime voice uses exactly this split: `background_agent` ("Do not rephrase the user's ask… pass along the user's own words") and `remain_silent`, with backend messages injected as `[BACKEND]` (openai/codex `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`, voice-research.md §1); OpenAI GPT-Live client delegation ([guide](https://developers.openai.com/api/docs/guides/live-delegation.md)).

### 3.2 Credentials stay on the computer; audio goes phone ↔ model
**What:** the phone sends its WebRTC offer through the end-to-end encrypted channel; pi on the computer creates the call with your ChatGPT sign-in (the endpoint Codex uses) or an API key and returns the answer. Audio flows directly between the phone and OpenAI; no token reaches the phone.
**Evidence:** *Source*: Codex call creation `POST /backend-api/codex/realtime/calls` with `{sdp, session}` (`codex-api/src/endpoint/realtime_call.rs`); public API `/v1/realtime/calls` ([docs](https://developers.openai.com/api/docs/guides/realtime-conversations)). *Measured*: calls created for `gpt-realtime-2`, `gpt-realtime-1.5` and transcription sessions with a ChatGPT sign-in. *Unverified*: the ChatGPT endpoint is undocumented and may change.

### 3.3 Always have a fallback
**What:** without realtime, "basic voice": phone VAD → recognition on the computer → distil → pi → spoken brief → speech from the computer (any OpenAI-compatible `/v1/audio/speech`, e.g. Voicebox or Kokoro) or the phone's own synthesis. `web/voice.js` cascade, `src/voice/tts.ts`.
**Evidence:** *Measured*: same question answered in ~5 s through the cascade, with and without server speech.

### 3.4 Tell the agent its user is listening
**What:** while voice mode is on, pi's system prompt gets a voice note: outcome first, one clear question, behaviour not identifiers, nothing to review on screen, confirm irreversible actions by name. Expires after 150 s without a heartbeat. `agentVoiceNote` in `src/voice/speech.ts`.
**Evidence:** *Source*: Codex switches the agent's expectations at the start and end of a voice session (`prompts/templates/realtime/realtime_start.md`, `realtime_end.md`).

---

## 4. Voice mode: what is said

### 4.1 Two output channels
**What:** pi writes as usual (the transcript keeps everything); what you *hear* is a separate spoken brief written for the ear. `BRIEF_SYSTEM`, `runDigest` in `src/voice/speech.ts`.
**Why:** written answers contain structure, code and lists that do not survive being read aloud.
**Evidence:** *Source*: Codex's voice prompt: don't read code, diffs or tables; give the takeaway (voice-research.md §1); Amazon cognitive-load guidance (above).

### 4.2 Talk about intent, not code
**What:** speech is about behaviour, design, decisions, trade-offs, risks and what is left; no identifiers, file names, commands, tool names or test names unless asked. Changes are reported by area of the system ("the authentication module"), not by file.
**Evidence:** *Source*: product decision from the user ("no-one speaks about variable names over voice mode"); consistent with Grice's maxim of quantity and Google's conversation design ([learn about conversation](https://developers.google.com/assistant/conversation-design/learn-about-conversation)). *Measured*: briefs like "When the user is missing, the authentication module throws an error saying no user was found for that ID."

### 4.3 Lead with the outcome; keep it short; at most two options
**What:** first sentence is the outcome; eyes-busy ≤ 2 sentences (~30 words), glance ≤ 3; questions answerable with yes, no or a short phrase; dialog options read two at a time ("or say *more options*"). `BRIEF_SYSTEM`, `speakPrompt` in `web/voice-core.js`.
**Evidence:** *Source*: rule of three and limited spoken lists ([Google](https://design.google/library/rule-of-three), [Alexa list patterns](https://developer.amazon.com/en-US/alexa/alexa-haus/patterns-and-components/patterns-lists)); listeners have ~8 s to act after a list.

### 4.4 Tool activity is not news, except significant actions
**What:** reads, searches, edits and routine commands stay silent. Actions touching production or data, deployments, shared history, deletions, external services or money are "significant": the voice knows when one runs, and a failure is announced with a tone and one sentence. `SIGNIFICANT` in `speech.ts` and `voice-core.js`.
**Evidence:** *Source*: product decision from the user; Codex's prompt allows progress updates only when "brief, grounded, and genuinely useful".

### 4.5 Sounds for state, words for news
**What:** short earcons for listening, heard-you, working (a soft tick every 6 s), needs you, done, failed, off. Speech only when something changes what you do next. `EARCONS` in `voice-core.js`.
**Evidence:** *Source*: earcons don't interfere with understanding concurrent speech; hierarchical earcons are learnable ([Brewster](https://eprints.gla.ac.uk/3247/1/using22_non_speech.pdf), [CHI](https://dl.acm.org/doi/pdf/10.1145/1518701.1518932), [review](https://www.tandfonline.com/doi/full/10.1080/25742442.2023.2219201)).

### 4.6 Never announce, just act
**What:** no "let me check"; the voice calls pi silently and the working tick fills the wait. Enforced on the phone: when the voice hands a request to pi, the audio it was producing with it is cut.
**Evidence:** *Source*: Codex's `remain_silent` tool and its "ack filler" setting; ElevenLabs speaks fillers only after a soft timeout and warns against fillers that promise a time ([docs](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)). *Observed*: instructions alone did not stop the model saying "Got it, I'll pass that along"; cutting the audio did.

### 4.7 Status answers from local state
**What:** "what's it doing?" is answered in one sentence without waking the agent: elapsed time, the kind of activity ("running the tests", never which file), and the last thing pi said it was doing. `voiceStatus` in `src/bridge.ts`.

### 4.8 Preferences stick; help is a question away
**What:** "be terser" holds until changed. A one-sentence spoken intro on first use; rotating example hints that fade after a few sessions; "what can I say?" gets a two-sentence answer.
**Evidence:** *Source*: Codex's voice prompt keeps stated preferences for the task; automatic hints help first use while regular users prefer help on request ([CUI 2020 study](https://www.porcheron.uk/assets/pubs/2020/kirschthaler2020what.pdf)).

---

## 5. Voice mode: turn-taking

### 5.1 Acknowledge at once, answer when ready
**What:** a "heard you" tone the moment your turn ends; delegated work takes seconds anyway.
**Evidence:** *Source*: human turn gaps are ~200–300 ms and silence starts to mean something around 700 ms; a real-home Alexa study measured 1,366 ms and no backchannels, and users slowed down to match ([SemDial 2025](https://www.semdial.org/anthology/Z25-Barthel_semdial_3315.pdf)). *Measured*: tone immediately; handed to pi in 1.1–1.2 s; spoken answer after pi read the code in 4.5–6 s.

### 5.2 Semantic end of turn when pi is silent
**What:** the server's `semantic_vad` (eagerness `auto`) decides when you are done; `turnDetection: "server"` switches to a fixed silence. In basic voice, a trailing "and…", "um" or "wait" keeps the floor open for 2.2 s.
**Evidence:** *Source*: OpenAI VAD guide ([docs](https://developers.openai.com/api/docs/guides/realtime-vad)); end-of-turn is judged on latency versus false cut-offs ([LiveKit](https://livekit.com/blog/solving-end-of-turn-detection)). *Observed*: eagerness `low` never closed a turn on our test audio.

### 5.3 Soft barge-in: duck, then decide
**What:** when you make a sound over pi, its voice drops to 20% at once; it stops after ~800 ms of voiced speech, or when your words turn out to mean something. "Mm-hmm", coughs and pi's own echo leave it talking. `clientTurns`, `clientVadFrame`, `duck`, `hardInterrupt` in `web/voice.js`; `isBackchannel` in `voice-core.js`.
**Why:** about half the sounds that trip a voice detector while an assistant talks are backchannels, coughs or noise; listeners backchannel ~7× more often than they interrupt.
**Evidence:** *Source*: [Deepgram on backchannels vs interruptions](https://deepgram.com/learn/backchannels-vs-interruptions-voice-agents) (45% false triggers); [LiveKit adaptive interruption](https://livekit.com/blog/adaptive-interruption-handling) (rejects 51% of VAD barge-ins); Hume `min_interruption_ms` default 800 ([docs](https://dev.hume.ai/docs/speech-to-speech-evi/configuration/interruption.mdx)). *Measured*: "mm-hmm" ignored (0 cancels); ducking 177 ms after you start; interruption committed and answered.
**Note:** the realtime server clears the assistant's audio on any detected speech regardless of `interrupt_response` ([community bug report](https://community.openai.com/t/issues-with-realtime-turn-taking/1369161)). So while pi speaks, server VAD is switched off and the phone does turn-taking; it hands back when pi is silent.

### 5.4 Never drop speech unheard
**What:** a short sound over pi is transcribed before it is judged; only the words decide whether it was a backchannel.
**Evidence:** *Observed*: an earlier version discarded a quick "Stop." spoken over pi's "…say stop to cancel" as a backchannel, and the deploy went ahead. Now it cancels (`confirm=false`).

### 5.5 Local commands are instant
**What:** "stop", "repeat", "status", "shorter", "go on", "yes/no", "option two", "what can I say?" are recognised on the phone; "stop" aborts pi before the model has answered. `parseCommand` in `voice-core.js`.
**Evidence:** *Source*: in the Alexa study the only fast responses users got were "stop" during agent speech ([SemDial 2025](https://www.semdial.org/anthology/Z25-Barthel_semdial_3315.pdf)).

### 5.6 Turn styles for the context
**What:** open mic (car, kitchen) or tap to talk (wind, traffic, cycling); the whole stage is the button; the headset play/pause button acts like a tap.
**Evidence:** *Source*: Claude app recommends push-to-talk in noise ([help](https://support.claude.com/en/articles/11101966-use-voice-mode)).

---

## 6. Voice mode: safety

### 6.1 Explicit confirmation for high-consequence actions only
**What:** permission dialogs are read out and answered by voice or tap; irreversible or outward-facing actions need the action named ("yes, deploy"); a bare "yeah" is refused by the phone even if the model tries to accept it. `answerFor`, `isDestructive` in `voice-core.js`.
**Evidence:** *Source*: confirm explicitly only when misunderstanding is costly; otherwise implicitly ([Google confirmations](https://developers.google.com/assistant/conversation-design/confirmations), [Alexa: be trustworthy](https://developer.amazon.com/en-US/alexa/alexa-haus/design-principles/be-trustworthy)). *Measured*: the model called `answer_question("yes")` on "Yeah."; the phone refused; "Yes, deploy" confirmed.

### 6.2 Ask once, with an undo window
**What:** if *you* just asked for exactly the action and target pi now asks to confirm, the phone (not the model) recognises it from what it heard, says "Deploying to production, say stop to cancel", and confirms after 4 s unless you say stop or tap Cancel. Targets come from the dialog's title, not its elaboration. `startGrace`, `requestNames`.
**Evidence:** *Pattern*: undo-instead-of-confirm (as in "undo send"). *Measured*: one spoken sentence instead of three confirmations; "stop" within the window cancelled (`confirm=false`).

### 6.3 pi's own voice is never consent; the room is not the user
**What:** speech heard while pi was talking that repeats pi's words is marked as echo and cannot answer a destructive question or count as an earlier request. `isEcho`, `rememberHeard`.
**Evidence:** *Source*: hidden instructions in ambient audio succeeded 69% of the time against a frontier model ([arXiv 2607.28165](https://arxiv.org/html/2607.28165)); background talkers end up in transcripts as the user ([Krisp benchmark](https://krisp.ai/blog/voice-isolation-benchmark/)).

### 6.4 Only relay what was clearly said
**What:** the voice asks you to repeat instead of guessing a task from a fragment or noise.
**Evidence:** *Observed*: see 2.10 (a leaked prompt became an invented task).

### 6.5 Eyes-busy is a mode, not a tone
**What:** "Eyes-free" makes answers shortest and defers anything visual ("the diff is waiting at a screen"); "Can glance" allows a little more. The setting reaches both the voice and pi.
**Evidence:** *Source*: complex voice tasks measurably degrade driving and the load persists afterwards ([Strayer et al.](https://link.springer.com/article/10.1186/s41235-016-0018-3), [NHTSA](https://www.nhtsa.gov/document/characteristics-voice-based-interfaces-vehicle-systems-and-their-effects-driving-0)); visual-manual limits of 2 s per glance, 12 s per task ([NHTSA guidelines](https://www.federalregister.gov/documents/2013/04/26/2013-09883/visual-manual-nhtsa-driver-distraction-guidelines-for-in-vehicle-electronic-devices)).

---

## 7. Voice mode: screen and platform

### 7.1 A few states, each with a label, a colour and a sound; an element that shows it hears you; captions
**What:** connecting, listening, thinking, working, speaking, needs you, off; an audio-reactive orb (your voice while listening, pi's while speaking); live captions. `Orb`, `render` in `voice.js`; `.voice[data-state]` in `app.css`.
**Evidence:** *Source*: voice agent UI guidance: a handful of states, never animation alone ([orb-ui guide](https://orb-ui.com/docs/guides/voice-agent-ui)); ChatGPT moved voice into the chat with a live transcript ([Engadget](https://www.engadget.com/ai/now-you-can-use-chatgpt-voice-without-leaving-your-chat-195000538.html)).

### 7.2 Hit it without looking
**What:** the whole stage is one button; mute and modes at the bottom; question cards with large answers; reduced-motion path.
**Evidence:** *Source*: NHTSA glance limits (above); accessible animation ([Pope Tech](https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/)).

### 7.3 Respect the platform
**What:** voice needs HTTPS (microphone access); on iPhone the mic stops when the screen locks, so voice mode keeps the screen awake and dark; `navigator.vibrate` is not relied on (no-op on iOS); AirPods stem mute via Media Session `togglemicrophone`, a cue on `voiceactivity` while muted, and `audioSession.type = "play-and-record"`.
**Evidence:** *Source*: WebKit background capture ([268791](https://trac.webkit.org/changeset/268791/webkit), [273069](https://trac.webkit.org/changeset/273069/webkit)); AirPods mute and `voiceactivity` ([WebKit #33469](https://github.com/WebKit/WebKit/pull/33469), [WebKit #31642](https://github.com/WebKit/WebKit/pull/31642), [Media Session spec](https://w3c.github.io/mediasession/)); [Audio Session API](https://developer.mozilla.org/en-US/docs/Web/API/Audio_Session_API); iOS web haptics ([notes](https://maid.zone/blog/2025-06-03-ios-web-haptics.html)). *Unverified*: whether the AirPods and `voiceactivity` features are on in shipping iOS Safari and Home Screen apps.

---

## 8. Process

### 8.1 Verify against the real thing, and measure turn-taking
**What:** unit tests for the pure logic; end-to-end runs in headless Chromium against real pi and the real realtime service, with a fake microphone (`browser.mjs`) and a scriptable one that speaks clips at exact moments (`turns.mjs`). Turn-taking is reported as numbers (ducking time, interruption, cancels), not impressions.
**Evidence:** *Source*: end-of-turn and interruption quality are now compared as measured curves ([eot-bench](https://github.com/livekit/eot-bench), [Full-Duplex-Bench](https://github.com/daniellin94144/full-duplex-bench)). *Observed*: real microphones never produce digital silence; the test microphone adds a quiet noise floor, because end-of-turn detection did not close turns on pure silence.

### 8.2 Prefer deterministic code to model judgement for safety
**What:** the undo window, echo detection, destructive-answer checks and the filler cut are decided on the phone, not left to prompts.
**Evidence:** *Observed*: the model ignored the undo-window instruction and kept adding filler despite instructions; deterministic checks fixed both in the same runs.

---

## 9. Known gaps

- **Playback quality while the mic is open on iPhone** (mono, low rate, crackling on some versions) is not managed yet: muting capture while pi speaks would restore it but conflicts with barge-in ([bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451), voice-research-2.md P1-2).
- **No second, non-spoken factor** for the most dangerous actions (production data, force push), such as a headset press (voice-research-2.md P1-5c).
- **No audio-native end-of-turn model** on the phone for basic voice ([Smart Turn v3](https://huggingface.co/pipecat-ai/smart-turn-v3)); the energy VAD plus trailing-word rule is simpler.
- **No speculative distillation** during pauses to cut the 2.5–3.5 s wait after dictation.
- **Real-device checks pending**: locked iPhone, AirPods stem and `voiceactivity`, Android with the screen off, echo cancellation on speakerphone.
- **A native iPhone app** would remove the screen-on requirement (background audio session) and allow Siri and Action-button start; see [voice.md → Platform limits](voice.md#platform-limits-verified-against-webkitchromium-sources-see-research-notes).
