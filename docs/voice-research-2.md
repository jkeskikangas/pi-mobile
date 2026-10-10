# Voice SOTA, round 2: turn-taking, voice UX, audio plumbing, safety (2026-10-10)

This builds on `docs/voice.md` and `docs/voice-research.md` and does not repeat them: Codex voice internals, GPT-Live delegation, STT/TTS pricing, Wispr basics, iOS background limits, and earcon and cognitive-load research are already covered there. **[verify]** marks a claim that needs a device test or comes from a single or vendor source.

---

## 1. Turn-taking and conversational dynamics

**Latency targets: human norms and how users react to slow agents**
- Gaps between human turns are typically 200–300 ms. Silence starts to *mean* something at about 700 ms, and about 1 s is the classic "standard maximum". A late "yeah" (~1.2 s) is heard as less agreeing, and slow responders come across as colder.
- In a corpus of 945 measured turn transitions with Alexa in real homes (SemDial 2025), the voice agent's mean floor-transfer offset was **1366 ms**, with very little variation. Users adapted: they treated gaps under about 3 s as normal and slowed their own turns too (mean 1497 ms).
- The paper also found **no backchannels at all** from the agent, and names this as a main cause of the stiff, one-shot exchanges.
- The only fast agent responses in that corpus were "stop" during agent speech, where users got immediate silence.
- https://www.semdial.org/anthology/Z25-Barthel_semdial_3315.pdf
- **Implication for pi.** Delegated work will always take seconds. What matters is that *something* happens within about 300–700 ms of the end of the turn: an earcon, a backchannel, or a short acknowledgement. Speech-to-answer latency matters less. pi-mobile's "heard-you" earcon is the right primitive; its timing should be measured (see P1-4).

**End-of-turn detection is now judged as a latency-versus-false-cutoff curve, not a single threshold**
- LiveKit Turn Detector v1 (June 2026) is audio-native (semantic and prosodic) and ships with an open benchmark, `eot-bench`. Reported false-cutoff rates:
  - At a 300 ms latency budget: LiveKit v1 9.9%, Deepgram Flux 12.9%, ultraVAD 27.7%.
  - At 600 ms: LiveKit v1 4.5%, Soniox 5.5%.
- Why text-only detection falls short: "one large pizza…" with rising versus falling intonation produces the same transcript, so only the audio can tell whether the turn is over.
- https://livekit.com/blog/solving-end-of-turn-detection · https://github.com/livekit/eot-bench
- Smart Turn v3 (Pipecat) is open: 8 MB int8 ONNX on a Whisper-tiny encoder, about 12 ms CPU inference. It is a candidate for browser inference with onnxruntime-web **[verify feasibility on phone]**. https://huggingface.co/pipecat-ai/smart-turn-v3
- OpenAI `semantic_vad`: `eagerness` takes low, medium, high or auto, and auto equals medium. A trailing-off utterance gets a longer timeout. `server_vad` supports `idle_timeout_ms`, which emits `input_audio_buffer.timeout_triggered`. https://developers.openai.com/api/docs/guides/realtime-vad · https://developers.openai.com/blog/realtime-api

**False barge-in (backchannels, coughs, background talk) is now handled by dedicated models**
- **LiveKit Adaptive Interruption Handling** (GA March 2026) is an audio CNN that looks at the first few hundred ms of overlapping speech:
  - 86% precision and 100% recall at 500 ms of overlap.
  - Rejects 51% of VAD-triggered barge-ins.
  - Median audio needed to trigger an interruption: 216 ms; inference ≤30 ms.
  - Detects true barge-ins faster than VAD in 64% of cases.
  - https://livekit.com/blog/adaptive-interruption-handling
- **Hume EVI**: `min_interruption_ms` defaults to **800 ms** (range 50–2000), and `end_of_turn_silence_ms` defaults to 800 ms. Hume recommends 1500 ms for "resilient" turn-taking when users backchannel or think aloud. https://dev.hume.ai/docs/speech-to-speech-evi/configuration/interruption.mdx · https://dev.hume.ai/voice/docs/speech-to-speech-evi/configuration/turn-detection.mdx
- **Deepgram** (Aug 2026), citing arXiv 2608.25218:
  - An energy-threshold detector fired on **45%** of backchannels and non-speech noise (52% in casual talk).
  - Listeners backchannel about **7× more often** than they actually interrupt.
  - Affirmative tokens ("mhmm", "uh-huh") mean *keep going*. Negative tokens ("uh-uh", "nuh-uh", "mm-mm") mean *yield now*.
  - "Right" and "okay" are ambiguous.
  - https://deepgram.com/learn/backchannels-vs-interruptions-voice-agents
- **ElevenLabs Agents** has three relevant settings:
  - `turn_eagerness` (patient, normal or eager); "patient" is recommended when the user is dictating structured data.
  - Interruption **ignore terms** (June 2026).
  - **Soft timeout**: a filler is spoken only if the LLM is slower than the timeout (recommended 3.0 s, at most once per turn). The docs warn against fillers that promise a time ("one second…").
  - https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow · https://elevenlabs.io/docs/changelog/2026/6/22
- **Background voices** are the unsolved part. Krisp's open benchmark (Sep 2026) has 265 real recordings with a competing talker:
  - Raw WER was 17–37% across 11 STT engines; voice isolation brought it down to 4–8%.
  - The failure mode for agents is that "words from the wrong person enter the transcript", and the agent hands over the turn to a background speaker.
  - Isolation can also silently *delete* the primary speaker's clauses, and the resulting transcript still reads clean.
  - https://krisp.ai/blog/voice-isolation-benchmark/

**Full-duplex models**
- GPT-Live removes the turn detector from the audio path. OpenAI's prompting guide asks you to keep three headed sections in the prompt:
  - `Backchannel policy` ("moderate" is a prompt instruction, not a frequency setting).
  - `Interruption policy`. The guide separates "stop talking" (yield) from "cancel my booking" (a task change routed to the backend).
  - `Delegation policy`.
- The guide also has optional controls:
  - "Do not treat a cough, music, or nearby conversation as a new request."
  - A **"Selected requests only"** mode for background listening (respond only when addressed).
  - Targeted clarification: "Was the last letter B or D?"
  - IPA pronunciation hints.
  - https://developers.openai.com/api/docs/guides/live-prompting
- Benchmarks now exist for full-duplex behaviour:
  - Full-Duplex-Bench v1–v3 covers pause handling, backchanneling, overlap, and multi-turn correction.
  - τ-Voice covers full-duplex agents making real tool calls.
  - https://github.com/daniellin94144/full-duplex-bench · https://arxiv.org/html/2603.13686v1
- Sesame CSM and Moshi are research and open-weight systems. They matter mostly as evidence that prosody and context-conditioned speech ("voice presence") are what make a voice feel present. https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice · https://arxiv.org/abs/2410.00037

## 2. Voice UX guidance (platform guides and products)

- **Confirmations.**
  - Google's taxonomy has three levels: explicit, implicit, and none. Use explicit confirmation only when the cost of misunderstanding is high.
  - Errors come in three types (no-input, no-match, system). On each retry, narrow the question and add more help.
  - Alexa: "Ask customers to confirm actions that have a high consequence… Use implicit and contextual confirmations." Use slot and intent confirmation sparingly, because users find it annoying.
  - https://developers.google.com/assistant/conversation-design/confirmations · https://developers.google.com/assistant/conversation-design/errors · https://developer.amazon.com/en-US/alexa/alexa-haus/design-principles/be-trustworthy
  - pi-mobile already does explicit confirmation that names the action. What is missing is *implicit* confirmation for non-destructive delegations, e.g. "Okay, looking into the login flow" only when the delegation was ambiguous.
- **Discoverability.** A Wizard-of-Oz study (CUI 2020) compared automatic hints with on-request "What can I say?":
  - Both beat no help on errors, completed stages and SUS score.
  - Automatic hints gave the fastest first use.
  - 12 participants said they would prefer on-request help once they used the system regularly.
  - Suggested design: automatic early, adaptive later, and sporadic hints so users discover features beyond the habits they settle into in the first few days.
  - https://www.porcheron.uk/assets/pubs/2020/kirschthaler2020what.pdf
- **Product direction.** ChatGPT moved Voice *into the chat* (Nov 2025). There is a live transcript and inline visuals, and the separate orb screen became an opt-in "Separate mode". "Live" (full duplex) is a selectable option. The lesson: a transcript beats an orb for trust and review. https://www.engadget.com/ai/now-you-can-use-chatgpt-voice-without-leaving-your-chat-195000538.html · https://help.openai.com/en/articles/20001274-chatgpt-voice
- **Gemini Live.**
  - Proactive audio is permanently on in `gemini-3.8-live`: the model may decide *not* to respond to irrelevant input.
  - Affective dialog adapts tone to the user's emotion.
  - Guided Vision (Oct 2026) was co-designed with blind and low-vision users, a useful reference for eyes-free design.
  - https://ai.google.dev/gemini-api/docs/live-api/best-practices · https://blog.google/innovation-and-ai/products/gemini-app/guided-vision-gemini-live/
- **Apple.** The Siri HIG is now mostly about App Intents. Siri's visual language is a full-screen edge glow rather than an orb, and iOS 27 ships unused "listening" and "thinking" glow assets (rumour level). There is little Apple guidance that transfers to a web voice UI. https://developer.apple.com/design/human-interface-guidelines/siri

## 3. Visual design of voice UIs

- The common pattern (ChatGPT, Gemini Live, orb-ui guidance) has three parts:
  - Exactly four or five visible states: connecting, listening, thinking/working, speaking, error.
  - An audio-reactive element that shows the mic is actually hearing you.
  - A transcript. orb-ui's guidance says the state must be understandable "without forcing users to interpret an animation on its own", so the state also needs a text label. https://orb-ui.com/docs/guides/voice-agent-ui
- Honour `prefers-reduced-motion` with a static equivalent. https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/
- **Haptics on iOS web.**
  - `navigator.vibrate` does nothing on iOS Safari, and pi-mobile calls it today.
  - The only workaround is the `<input type=checkbox switch>` haptic (Safari 18+). It fires only on a *trusted user tap*, so it can confirm a tap-to-talk press but can never notify the user.
  - https://github.com/tijnjh/ios-haptics · https://maid.zone/blog/2025-06-03-ios-web-haptics.html
- **Driving.** The existing NHTSA figures still apply: at most 2 s per glance and 12 s total. Practical consequences:
  - One large glyph plus one line of text, no lists.
  - The whole screen acts as a tap target.
  - High contrast for sunlight.
  - Nothing that *changes layout* while you are glancing at it.

## 4. Agents, long-running work, safety

- **Delegated actions.** GPT-Live's guidance: "Your application checks permissions and required confirmations before executing an action." The voice model must wait for the backend before claiming that something was done. Cancelling a task is a backend action that has to be confirmed, separate from stopping speech. pi-mobile matches this, since the phone refuses an unnamed "yeah". https://developers.openai.com/api/docs/guides/live-prompting
- **Audio prompt injection is now shown to work in real conditions.**
  - "Piggybacking on Perception" (arXiv 2607.28165) hid instructions in concurrent ambient audio and reached **69% attack success against Gemini 3 Pro**. Its source-separation and consistency defence (CADV) detected up to 96% of attacks.
  - Near-ultrasonic covert prompts on commodity hardware (USENIX Security 2026).
  - Adversarial background noise against audio LLMs in the real world (EACL 2026).
  - The threat to pi is any audio in the room, including **pi's own speech coming back through the mic** when it reads text that came from the repo or the web.
  - https://arxiv.org/html/2607.28165 · https://www.usenix.org/system/files/usenixsecurity26-ling.pdf · https://aclanthology.org/2026.eacl-long.66.pdf
- **Proactivity.** The research (CHI 2025 Codellaborator; LLM-based interruptibility scheduling) consistently finds that proactive interruptions are both helpful and disruptive, and that *timing and channel* matter more than content. I only read abstracts here; treat this as directional. https://kevinpjk.github.io/assets/pdf/codellaborator_chi_2025.pdf · https://dl.acm.org/doi/10.1145/3746059.3747748

## 5. Hands-free activation and audio-session pitfalls (WebKit specifics)

- **AirPods stem press mutes the mic (WebKit PR #33469, merged Sep 2024).** While a page captures the mic, an AirPods stem press toggles the *page's* microphone mute. On iOS the system mutes it directly. It sits behind the `UseMicrophoneMuteStatusAPI` preference, and the page sees it as track mute/unmute. The spec says the UA runs the `togglemicrophone` handler before setting `track.muted`. Whether this is on by default in iOS 26 Safari, and in Home Screen PWAs, is **[verify]**. https://github.com/WebKit/WebKit/pull/33469 · https://w3c.github.io/mediasession/
- **`voiceactivity` MediaSession action (WebKit PR #31642, merged Sep 2024; W3C spec).** It fires when the user speaks while the mic track is *muted*, using OS voice detection, and the audio unit stays running. This enables a "you're muted" cue, or *mute-as-standby*: the mic is muted to the model, and the OS still tells the page you started talking. **[verify shipping status]** https://github.com/WebKit/WebKit/pull/31642 · https://github.com/w3c/mediasession/pull/333
- **Microphone use degrades playback on iOS.**
  - While `getUserMedia` is active, output drops to a lower sample rate and to mono, even with `echoCancellation:false`. This is worst on AirPods (bug 311451, still present in iOS 27 beta).
  - An iOS 26.2–27 regression adds *crackling* output while capture with echo cancellation is active (bug 326286).
  - WebKit leaves PlayAndRecord synchronously once all capture tracks are muted or ended (PR #31537). So muting the track between turns should restore full-quality output **[verify switch latency]**.
  - https://bugs.webkit.org/show_bug.cgi?id=311451 · https://github.com/WebKit/WebKit/pull/31537 · https://support.apple.com/en-us/102217
- **Audio Session API.** `navigator.audioSession.type` can be `playback`, `transient`, `transient-solo`, `ambient`, or `play-and-record`. Safari ships the type-only subset. `transient-solo` suits short spoken notices that should pause the user's music; `ambient` suits earcons that mix in. https://developer.mozilla.org/en-US/docs/Web/API/Audio_Session_API
- **Long-standing WebRTC routing bugs on iOS.**
  - Output can switch to the speaker when capture starts with Bluetooth connected.
  - The audio rate can glitch when switching to or from Bluetooth.
  - AirPods behaviour can depend on other tabs.
  - https://bugs.webkit.org/show_bug.cgi?id=252175 · https://bugs.webkit.org/show_bug.cgi?id=232822
- **`voiceIsolation` getUserMedia constraint.** It is standardised, but Chrome applies it only on some ChromeOS devices. On iOS the user's Control Center *Mic Mode → Voice Isolation* may apply to Safari WebRTC **[verify]**. https://chromestatus.com/feature/5106413661847552 · https://w3c.github.io/mediacapture-extensions/
- **In-browser wake word.** openWakeWord runs fully client-side through ONNX Runtime Web. It needs the page in the foreground and the mic live, which costs battery and conflicts with the playback-quality problem above. https://www.npmjs.com/package/openwakeword-web

## 6. Dictation beyond Wispr

- **Wispr Flow learns from corrections.** "When you correct a spelling, Flow adds it automatically to your personal dictionary." Entries carry provenance ("learned automatically" from corrections, app context, transcripts), and teams can share dictionaries. A dictionary entry reaches the recogniser *before* it listens; a replacement rule only fixes the output afterwards. https://wisprflow.ai/features · https://docs.wisprflow.ai/articles/9639977157-view-shared-dictionary-words-and-snippets-in-the-admin-portal
- **Inline voice editing.**
  - Typeless (on-device, Android 2026): "delete that" and "make that a list" act on the *selection*.
  - Shaberu: "new paragraph" and "list" are spoken mid-sentence and carried out, never typed.
  - Wispr Command Mode: spoken instructions on selected text.
  - Hybrid tools (Vaitly) keep recognition local and send only the finished text to a larger model for "polish".
  - https://getshaberu.com/en · https://vaitlyvoice.com/technology/offline-vs-cloud-dictation/

---

## Prioritised improvements for pi-mobile

### P1: high value, feasible now

**P1-1. Duck, then decide, on barge-in (backchannel-aware interruption).**
- *Why.* An energy or VAD detector fires on about 45% of backchannels and noise, and backchannels are about 7× more common than real interruptions. LiveKit's model rejects 51% of VAD barge-ins. pi's open mic is used in a car or kitchen, which is the worst case, and the long spoken briefs are exactly what users backchannel through.
- *How.*
  - Realtime mode: set `interrupt_response:false`. On `input_audio_buffer.speech_started`, immediately duck the remote audio element (or its GainNode) to about 20% instead of stopping.
  - Yield (`response.cancel` + `output_audio_buffer.clear`) when either holds:
    - speech lasts ≥ about 400 ms (tunable; Hume's default is 800 ms), or
    - the streaming input transcript contains a yield token: no, stop, wait, uh-uh, a name, or any word other than a backchannel.
  - Otherwise restore the volume within about 150 ms and let the model treat the turn as a backchannel (prompt: "if the user only said mm-hmm/okay/right, call remain_silent").
  - Local commands ("stop") still yield instantly.
  - Basic mode: the same logic in `voice-core.js` VAD.
  - Log each decision so thresholds can be tuned.
- *Caveat.* With `create_response:true` the server may still answer a bare "mm-hmm". Test whether `remain_silent` is reliable enough, or move to `create_response:false` with a client-side `response.create`.

**P1-2. Audio-route manager: full-quality listening when not talking.**
- *Why.* While the mic is captured, iOS forces mono, low-rate and possibly crackling output (bugs 311451 and 326286). Briefs on AirPods sound "tinny" for the whole session.
- *How.*
  - In tap-to-talk and eyes-busy modes, *mute (`track.enabled=false`) or stop the capture track while pi speaks*, so WebKit drops PlayAndRecord. Set `navigator.audioSession.type` to `playback` while speaking briefs and back to `play-and-record` when listening. Play earcons through a separate `transient` or `ambient` path.
  - In open-mic barge-in mode, keep capture but offer a "listening quality" toggle.
  - Measure route-switch latency first: if it is above about 500 ms, pre-open the mic as the brief ends.
  - Replace `navigator.vibrate` (a no-op on iOS) with the switch-haptic only on the tap-to-talk button.

**P1-3. AirPods stem and mute as push-to-talk, plus a "speaking while muted" cue.**
- *Why.* WebKit maps AirPods stem presses to page mic mute and fires `voiceactivity` when you talk while muted. That gives a hands-free, wake-word-free control that is better than the `<audio>` play/pause trick in the existing notes.
- *How.*
  - Listen to `track.onmute` / `onunmute` and the `togglemicrophone` handler (already registered), and call `mediaSession.setMicrophoneActive()`.
  - Register `setActionHandler('voiceactivity', …)` to play a soft "you're muted" earcon, or, in an opt-in "standby" mode, unmute and start a turn.
  - Feature-detect, and add a device check to `test/e2e`.
  - Everything here is **[verify]** on iOS 26 Safari tab versus Home Screen PWA.

**P1-4. Instrument turn-taking and build a regression harness.**
- *Why.* SOTA is now judged on latency-versus-false-cutoff curves (eot-bench). pi has an e2e WAV harness but measures no turn metrics.
- *How.*
  - Log per turn:
    - `speech_stopped` → heard-you earcon
    - → first audio
    - false cutoffs (the user resumes within 1.5 s of the turn closing)
    - false barge-ins (the user's "interruption" transcribes to a backchannel or nothing)
    - delegate → brief
  - Add WAV fixtures for: thinking pauses ("so in the… login flow"), a rising-intonation trail-off, a cough during a brief, a background TV talker, and "mm-hmm" during a brief.
  - Targets: earcon at most 300 ms after the end of the turn; locally answered "status" spoken in at most 800 ms; false-cutoff rate under 5%.

**P1-5. Self-echo and ambient injection guard for consequential actions.**
- *Why.* Concurrent audio injection reached 69% success against a frontier model. Background voices get transcribed as the user. pi may read repo or web-derived text aloud, which could echo back as a "command".
- *How.*
  - **(a)** Reject any confirmation ("yes, push"), and any new destructive delegation, whose speech overlapped pi's own output playback or started within about 300 ms of its end. Re-ask after silence.
  - **(b)** Never put verbatim untrusted text (web pages, issue bodies, commit messages) into speech during eyes-busy mode; paraphrase it.
  - **(c)** For production, money or force-push actions, require a second, non-acoustic factor when one is available: an AirPods stem press or a long-press anywhere on the screen within 5 s ("say *yes, push*, then press once").
  - **(d)** Have the voice layer flag `[PI]`-sourced text that looks like an instruction, and never act on it.

### P2: clear improvements, more work

**P2-1. A transcript-first glance screen.** This follows ChatGPT moving voice into the chat.
- The voice screen is the session's transcript plus one large state glyph with a text label (Listening, Working 2:14, Needs you, Failed), with the last spoken sentence as big captions.
- `prefers-reduced-motion` gives a static glyph; there is a level meter only while listening.
- In eyes-busy mode: the whole screen is the tap target, there is no scrolling list, and the layout never changes while you glance.
- Colour is never the only signal (shape plus text).

**P2-2. Adaptive discoverability.**
- For the first about 3 sessions, append one hint to the first brief ("you can say *status* or *shorter* anytime").
- After that, hints appear only after a no-match or a failed command, plus a rare "did you know" when a command has never been used.
- "What can I say?" works locally. Store counts per command in localStorage.

**P2-3. Escalating, targeted repair.**
- On a no-match: first a short reprompt, then a narrowed question with options (at most 2), then "I'll keep that for the screen."
- Use vocabulary-match ambiguity from `vocab.ts` to ask about *the unclear part only* ("the login or the logout flow?"), as GPT-Live's prompting guide recommends.
- Add implicit confirmation only when the delegation was rephrased or ambiguous.

**P2-4. Interruption etiquette and an away-digest for async work.**
- Queue pi notifications by urgency:
  - **Needs-you** speaks at the next turn boundary, never over the user.
  - **Failed significant action** gets an earcon now and words at the boundary.
  - **Done** gets an earcon only, with words on request.
- When voice mode resumes after more than 5 minutes away, give one "while you were away" brief: needs-you first, then failures, then finished work, at most 3 items, and offer more.
- With several sessions, give each its own earcon timbre and stereo pan through headphones (StereoPannerNode), so "which agent?" can be answered without words. This draws on Brewster's hierarchical earcons; it is a beyond-SOTA idea and untested.

**P2-5. Learn the dictionary from edits (dictation).**
- When the user edits a distilled prompt before sending, diff it against the distillation.
- If a replaced span was a misheard form of a repo or session term, store the pair `{heard → term}`.
- Feed learned terms into recogniser biasing (Apple contextual strings, keywords) *and* the distillation prompt, with provenance and a `/voice forget` command.
- Store this per repo on the host.

**P2-6. Voice edits on the distilled prompt.**
- After distillation, a short spoken follow-up is treated as an *edit instruction*, not new text, when it starts with an edit verb ("make that a list", "drop the part about tests", "replace X with Y").
- It runs the same model on (draft, instruction) and shows a diff highlight.
- This applies to the terminal (alt+m again) and the phone composer.

**P2-7. Speculative distillation.**
- Start distilling on every pause longer than 700 ms. Keep the result if no new speech arrives, and discard it otherwise. This is the same idea as Flux EagerEndOfTurn and LiveKit preemptive generation.
- It would cut the observed 2.5–3.5 s post-stop delay toward about 1 s, at the cost of extra model calls.

### P3: worth prototyping

- **P3-1. Context-adaptive turn policy.**
  - Estimate noise and the presence of other talkers from the VAD and the level meter. When they are high, suggest tap-to-talk or Mic Mode Voice Isolation **[verify iOS]**.
  - Switch `semantic_vad` eagerness to `low` (or Hume-style patient timing) when the user is describing a design, and to `high` for yes/no answers.
- **P3-2. GPT-Live path.** Use a minimal backchannel policy for coding ("rare; never during numbers or names"), "Selected requests only" while passengers talk, and an IPA or spoken-form lexicon for project names from `vocab.ts`. Requires an API key.
- **P3-3. In-browser turn model.** Run Smart Turn v3 (8 MB ONNX) in an AudioWorklet in basic mode to replace the silence-only VAD. Measure battery and latency on the phone first.
- **P3-4. Optional on-device wake word** (openWakeWord web), only while foregrounded and plugged in, for example a kitchen or desk stand.

### Uncertain or unverified

- Whether the AirPods-mute and `voiceactivity` WebKit features are on by default in shipping iOS Safari and Home Screen PWAs.
- The latency of the PlayAndRecord ↔ playback route switch.
- Whether iOS Mic Mode applies to Safari WebRTC.
- The Codellaborator and interruptibility findings (abstract-level only).
- Vendor benchmark numbers (LiveKit, Krisp, Deepgram) are self-reported; Krisp and LiveKit publish open datasets and harnesses.
