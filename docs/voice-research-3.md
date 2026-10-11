# Voice SOTA, round 3: which channel carries what (2026-10-11)

Builds on `docs/voice-research.md` and `docs/voice-research-2.md` (Codex voice internals, GPT-Live pricing, turn-taking, earcons are covered there). Question for this round: in a coding agent, when should input and output be speech, text, or both? **[verify]** marks a vendor-only or single-source claim.

## 1. Products

- **ChatGPT Voice on desktop (GPT-Live).** Voice runs *inside* an existing Codex task: "Voice uses that task's conversation and selected model", so a typed task can be continued by voice. It starts separate tasks for longer work, "brings progress, blockers, and results back to your voice conversation", and switches between tasks by voice ("let me talk to the task reviewing the tests"). Screen context: "take a look at this" sends an *appshot* of the frontmost window, including its accessible text. Voice chat and dictation are separate features with separate entry points. One voice chat at a time per app. https://learn.chatgpt.com/docs/features/voice.md
- **ChatGPT Voice (all apps).** "Voice works within a chat, so you can listen while following the response in text, type when you cannot speak, and review earlier messages." The transcript is one tap away; it is not shown by default on the voice screen. https://help.openai.com/en/articles/20001274-chatgpt-voice
- **Kazoo** (open source, OpenAI Realtime + Claude Agent SDK). A voice *supervisor* narrates a coding *worker*. Its lessons: (a) Realtime with server VAD "hallucinated the project" by answering on its own; the fix was a supervisor that answers only from conversation context and delegates every fact it can't verify (`reason: 'new_task' | 'unknown_fact'`); (b) barge-in on the voice never stops the worker; (c) they abandoned the TUI because it "was mostly duplicating the voice, a transcript echo, while failing to show the things voice physically can't convey: diffs, file trees, results, the current action. The screen should show you what you can't hear." https://github.com/agent-grid/kazoo
- **Heard** (macOS, open source). A listen-only layer over Claude Code, Codex and Cursor: spoken summaries, not read-outs. Two modes, *full commentary* and *quiet until something needs you* (errors, decisions). With parallel agents it summarises at the project level instead of per agent. Pairs with a phone. **[verify]** https://blog.mohitshekhawat.com/heard-voice-layer-claude-code-codex-cursor/

## 2. GPT-Live client delegation (the plumbing that fits pi)

https://developers.openai.com/api/docs/guides/live-delegation.md · https://developers.openai.com/api/docs/guides/live-prompting.md

- The live model handles only the conversation. With `delegation: {type: "client"}` our application (pi) is the backend. `session.delegation.created` carries an id and a timestamp, *not* the task text; the application builds the request from `session.input_transcript.delta` and its own state.
- Three ways to talk back, each up to 500 tokens: `session.commentary.append` (say this, paraphrased), `session.thinking.append` (know this, don't say it now: quiet progress and UI context), `session.instructions.append` (redirect; can interrupt current speech).
- **Typed input** goes to the backend as exact user data, optionally mirrored into the live model with `thinking.append`. **UI context**: "Give GPT-Live a concise summary of the current page or task, relevant selections, and facts that help interpret references such as 'this option'", sent at start and on change, as `thinking.append`.
- Prompt template has fixed sections: backchannel policy, interruption policy, delegation policy ("Delegate before giving an answer that depends on backend work. Do not guess the result while waiting."). Acknowledging a delegated request is allowed and measured separately from the answer.
- Interrupting speech leaves backend work running; cancelling work is a separate, explicit backend action.
- Requires an OpenAI project API key; billed per second ($0.05/min per round 1). Codex uses `gpt-live-1-codex` with the ChatGPT sign-in; whether a third party can use that sign-in for GPT-Live is unknown. **[verify]**

## 3. Research

- **Sidekick** (UIST '26, n=30). Multitasking with a background computer-use agent. Three stages, three treatments: *background* → ambient cues (one-sentence status + colour: green, yellow, orange, red; auto-pause at red); *resuming* → a multimodal summary of what happened (speech plus visual highlights), agent paused during the summary; *foreground* → spoken reasoning synchronised with on-screen highlights. Beat both a chat-text baseline and a peripheral-text baseline on multitasking performance, error catching and traceability, without hurting the primary task. Formative study: users alt-tab to check progress "from time to time" to avoid losing context; dense terminal text was "overwhelming". http://guoanhong.com/papers/UIST26-Sidekick.pdf
- **When More Is Not Better** (CUI '26). Richer multimodal output has spatial and temporal costs that raise cognitive burden; proposes an information-per-space-and-time metric. Only the abstract was reachable. https://dl.acm.org/doi/10.1145/3816046.3816267
- **Effects of Interaction Modality on LLM-Based Information-Seeking** (MuC '26, n=33, honourable mention). Text vs voice vs mixed modality within subjects. Only the abstract was reachable; results not verified. https://dl.acm.org/doi/10.1145/3820253.3820261
- **Reading vs listening** (meta-analysis, 46 studies, N=4,687). No overall difference in comprehension (g=0.07), but *self-paced reading* beats listening (g=0.13), and reading helps more for inferential questions. Technical review is self-paced and inferential, so it belongs in text. https://journals.sagepub.com/doi/10.3102/00346543211060871
- **Background speech while writing** impairs writing; interruptions add to it. Speech that arrives while the developer types costs them, so speech should wait for a pause in typing unless it is urgent. https://exa.ai/library/publication/bl2sfw7strh
- **Full duplex.** Moshi listens and speaks at once (~200 ms); a June 2026 paper improves *when* it backchannels and yields, which is still the weak part. https://arxiv.org/abs/2410.00037 · https://arxiv.org/abs/2606.11167

## 4. What nobody does yet

- Route output by **where the developer's attention is**. Every product above picks the output channel per *mode* (voice chat on or off, commentary or quiet), not per moment.
- Make the two channels **complementary**: the voice refers to what is on screen ("the second file") and the screen highlights it, instead of the screen captioning the voice (Kazoo's "transcript echo") or the voice reading the screen.
- Treat **typing and speaking as one turn**: speak the intent, type the exact token.
- Hold speech while the developer is **typing**, using keystroke activity as the interruption signal.
