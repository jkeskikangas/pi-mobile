# Voice and text together — Design

**Status:** draft v2, 2026-10-11 · **Research:** `docs/voice-research-3.md`, `docs/voice-research.md`, `docs/voice-research-2.md` · **Builds on:** `docs/voice.md` (voice input and voice mode as they are today).

## The bar

Good voice UX is obvious: after a day the developer can't imagine it working any other way. That means the developer can always predict what will be **spoken** and what will be **written**, and can always **see** how what they said and what they typed become one request. Fixed rules beat clever inference: a rule you can learn is better than a guess that is right most of the time.

## Rules

### Output: one rule, always the same

**The voice says how it went and when you're needed, in one sentence. Everything else is text.**

| Spoken | Written |
|---|---|
| The outcome of a request: "Renamed, tests pass." | pi's full answer, as today |
| A question pi asks you, then its options | The same question with its options (answer either way) |
| A significant action that failed (deploy, push, delete, production data) | The failure with details |
| Answers to what you ask the voice ("what's left?") | — (already in pi's text) |

- Every answer in pi's text starts with the sentence that was spoken, as one line marked **said** in the voice colour, then the detail. What you heard can always be found, and the detail is never read aloud.
- Code, paths, diffs, numbers, lists and links are never spoken unless you ask; the voice names things the way a person would ("the login flow"). Today's spoken-brief rules (`packages/pi-speech/src/speech.ts`) apply unchanged.
- **Only timing adapts, never the channel.** Speech waits until you stop typing (about 1.5 s without a key). A question or failure plays its sound at once and is spoken at the next pause. The working tick never plays while you type.

Two explicit switches, no inferred states:

| Switch | Effect |
|---|---|
| **Quiet** (meetings, open office) | Nothing is spoken. Sounds still mark *needs you*, *done*, *failed*. |
| **Eyes-free** (the phone's existing mode) | Longer spoken briefs; nothing assumes you can read. |

Both are said or toggled ("go quiet", "I can't look") and shown in the status line at all times.

### Input: the editor is where a request is assembled

Speech and typing meet in one visible place: pi's editor.

1. **A complete spoken request goes to pi at once.** It appears in the transcript in your words, like a typed message.
2. **A spoken request that points at something to come waits in the editor.** "Rename it to the following", "use this:", "change it to…": the spoken words land in the editor as a marked, dim segment with the cursor after it, and the status line says *Finish typing · Enter sends*. The voice says nothing.
3. **Typed text is exact.** It goes to pi as typed; it is never re-heard, corrected or paraphrased.
4. **Enter sends, as always.** Saying "send" does the same. Esc turns the spoken segment into ordinary editable text. A parked request never sends itself.
5. **"This" means what is on screen.** Spoken "this" or "that" refers to the editor's text when there is any, otherwise to the last thing pi showed (the last answer, error or question). With text in the editor, "rename it to this" assembles the same line as in rule 2.

The example:

```
you say    "rename it to the following"
editor     ● rename it to the following: ▏              Finish typing · Enter sends
you type   foo.ts
editor     ● rename it to the following: foo.ts▏
you press  Enter
pi gets    rename it to the following: foo.ts         (one message, foo.ts verbatim)
you hear   "Renamed, and the imports are updated."
pi shows   said  Renamed, and the imports are updated.
           …the details, files, diff…
```

Why it is obvious: nothing unsent is invisible, nothing is merged behind your back, the spoken and typed parts look different, and Enter keeps its meaning.

### Dictation stays separate

`/dictate` and alt+m turn speech into a prompt you edit before sending; nothing is spoken back. Voice mode is a conversation. Both use the editor the same way, so moving between them needs nothing new.

## Long-form: talk it through, get a draft

Talking for minutes is how people think through a feature, a bug or a design. Claude's dictation, Superwhisper's modes and Wispr Flow summarise such a ramble once, at the end. That leaves three gaps: nothing shows what was understood while you talk, the summary can lose or invent things without you noticing, and fixing it means editing a wall of text or rambling again. Here the result is a **draft**: a structured Markdown document you watch form, can check against what you said, and keep shaping by voice or keyboard until Enter sends it.

### Rules

1. **Length is not a mode.** A short dictation becomes a prompt, as today. A long one, or one whose content is a description rather than a request, becomes a draft. Nobody picks a mode.
2. **You end it, not a pause.** Pauses are thinking. A draft recording ends on Enter, alt+m, or "that's it" (in voice mode). The limit is 10 minutes; a minute before it, the status line says so.
3. **Faithful and checkable.**
   - Nothing is added that you didn't say.
   - When you contradict yourself, the later statement wins and the draft notes it: *You first said X, later Y; kept Y.*
   - Tangents go to an **Also mentioned** section; nothing you said is dropped silently.
   - Ambiguities become **Open questions**.
   - The transcript is written to disk as you speak; `/dictate raw` shows it, and neither a crash nor Esc loses it.
4. **The shape follows the content, and you can name it.** A request becomes a prompt, a design musing becomes design notes, several things to do become a task list. Saying the shape at either end ("make this a spec") overrides the guess.
5. **The draft forms while you talk.** There is no summarising step at the end: the draft is updated continuously from what you say, so finishing is instant and you see what was understood (and can correct it) while you are still speaking.
6. **The draft is refined by voice** ("drop the third point", "add that it must work offline") **or by typing**, in any mix. Enter sends it to pi.

### Drafting continuously

The draft is the only live view: no separate outline, no final summary.

- **When:** at each natural pause (about 1.5 s without speech), or after ~15 s of new speech without one; never more than one update in flight. The latest words always appear at once in a dim *Hearing* line at the bottom, so the screen is never behind your voice.
- **How:** each update gets the current draft and the speech since the last update, and returns **edits to sections** (add a point, change a point, move a point, resolve an open question), not a rewrite. Edits are applied as given, so the glow marks exactly what changed and the structure stays stable while you watch: a point you are reading doesn't jump.
- **Contradictions are resolved as they happen:** "no wait, cap it at three" changes the earlier point, and the change glows. You see the correction land.
- **Model:** the fast model for the live updates (latency and cost: about 30 updates for 10 minutes, each ~3k tokens in and a few hundred out). When you finish, one **reconciliation pass** with the session's model checks the draft against the whole transcript: anything missing goes back in, anything not said comes out, contradictions are confirmed. It changes only what is wrong, and those changes glow too. Finishing therefore takes a second or two, not a summarisation wait.
- **Faithfulness holds for every update:** nothing added, nothing dropped (tangents to *Also mentioned*), ambiguities to *Open questions*.

### The draft view: full screen, rendered Markdown, changes glow

While you dictate a draft, the draft view takes the whole terminal except pi's status bar (a full-width overlay sized to the terminal's height minus the footer, via `ctx.ui.custom()`). pi's transcript returns when the draft is sent or closed.

```
 Draft · retry and upload fixes                                 ● 6:42

 Goal
 Make uploads survive flaky networks without user retries.

 Requirements
 • Exponential backoff on upload, capped at 3 retries        ← glowing
 • Fix the flaky upload test (likely the timeout)

 Open questions
 1. Should the cap apply to downloads too?

 Also mentioned
 • Docs need a section on offline use

 Hearing: …and the error message should say how long until

 Enter finish · Esc keep as text · /dictate raw transcript
```

- **Rendered Markdown, always.** Headings, bullets, emphasis and code are shown formatted (pi-tui's `Markdown` component, the theme's Markdown colours). You never see Markdown syntax while dictating.
- **Typing:** when you type, only the line you are editing shows its source, and only while the cursor is on it; every other line stays rendered. This is the live preview Typora and Obsidian use, the least surprising way to type into rendered text.
- **Recent changes glow, then fade.** What dictation just added or changed gets the accent background, stepping down through two dimmer shades to normal over about three seconds. Removed text stays briefly as dim struck-through text, then disappears. Your own typing is never highlighted: the glow means "this came from what you said".
- **It follows the change.** The view scrolls to keep the latest change visible. Scrolling or typing yourself stops the following until the next dictated change.
- **Without motion** (a reduced-motion setting, or a terminal without enough colours): no fade; changed lines get a `▎` mark in the left margin until the next key press.
- **After you finish,** the same view stays open for refining: dictate again (alt+m) to edit by voice, type to edit by hand. Enter sends the draft to pi; Esc puts it in pi's editor as ordinary text; nothing is lost either way.
- Short dictation (a prompt) keeps today's behaviour in pi's editor; the full-screen view is only for drafts.

### In voice mode: recognising a monologue

In a conversation a long monologue is "thinking out loud". The voice must neither interrupt nor send fragments to pi.

- **Intent, not keywords.** The voice model recognises that you are composing something (describing a feature, listing requirements, reasoning about a design) and calls a `draft` tool. From then on what you say goes into the draft instead of into the conversation.
- **Duration as a backstop.** Continuous speech for more than ~20 s without addressing the voice also starts a draft (decided locally, so the model can't miss it). Draft capture starts mid-utterance without losing anything already said.
- **Visible, and undoable.** Starting a draft is obvious: the draft view opens with the draft forming, and a soft tone marks it. If it was wrong ("no, just answer that"), the draft closes and what you said becomes an ordinary request.
- **While drafting** the realtime session stops creating responses (`turn_detection.create_response: false`) so pauses never trigger a reply; the voice stays silent.
- **Closing:** "that's it", or a pause of ~8 s after which the voice asks once, quietly, "is that everything?".
- **Read-back follows the output rule:** one spoken sentence ("Got it: three things, retries, the flaky test and docs, and two questions"), the draft as text.
- **Clarifying by voice.** The voice asks the open questions one at a time; each answer edits the draft, and the edit glows. Voice is better than text at this.
- **Sending:** "send it", or Enter. Eyes-free (phone): the read-back gives the count and the top-level points; the draft waits on screen.

Dictation and voice mode share the draft and the draft editor; the only difference is whether a voice talks back.

### Phase 1: long dictation in the terminal (buildable now)

| Area | Change |
|---|---|
| Recording (`dictation.ts`) | `MAX_MS` 5 min → 10 min, with a warning a minute before. No silence stop once the recording is longer than 30 s (silence still stops a short dictation with nothing said). |
| Transcript safety | Recognised text is appended to `<speechDir>/drafts/<timestamp>.txt` as each segment finalises; deleted after the draft is sent, or after 7 days. `/dictate raw` reads it. |
| Recogniser | Apple: verify a continuous 10-minute stream first; if it degrades, restart the stream at a pause every few minutes, carrying context hints over. OpenAI: transcribe in ~60 s chunks cut at pauses. |
| Becoming a draft | A dictation becomes a draft after ~30 s of speech, or earlier when the first update finds a description rather than a request. Shorter ones stay prompts, as today. |
| Continuous drafting | Updates at pauses or every ~15 s of new speech, one in flight; the fast model returns section edits; applied deterministically. On finish, one reconciliation pass against the whole transcript with the session model. |
| Draft view | Full-screen overlay minus the status bar; rendered Markdown; live preview on the line being typed; glow-and-fade for dictated changes; the *Hearing* line; follow-the-change; the no-motion fallback. Enter sends, Esc moves the draft to pi's editor. |
| Refining | Dictating while the draft view is open edits the draft ("Editing by voice", already in `distill.ts`), as section edits that glow. |
| Tests | Section-edit parsing and application (add, change, move, resolve; stable order); the glow marks exactly the edited lines, fades on schedule and never marks typed text; transcript written incrementally and recoverable after a crash; reconciliation restores a point an update dropped; a 10-minute recorded ramble (file mic, `PI_SPEECH_MIC=file:`) produces a draft that keeps every point from a hand-made checklist and adds none. |

Later phases: the draft editor and drafts in the phone composer; the monologue handling in voice mode.

## Behaviour of the voice itself

1. **The voice never knows; pi knows.** It answers only from the conversation and pi's reports. Anything needing a tool, a file or current information goes to pi (issue #5).
2. **Acknowledge lookups, not work.** A question pi answers by looking something up (weather, docs, a file) gets "Checking." because the wait would otherwise be silent. Coding work keeps today's rule: no announcement, the working tick carries the wait. This revises `docs/voice.md` principle 12 for lookups only.
3. **Interrupting the voice never stops pi.** "Stop" stops the voice; stopping pi is said explicitly ("stop pi", "cancel that").
4. **One voice, many sessions.** The voice talks to the session in the terminal you started it from. "Switch to the API session", "what's the box doing", "anything need me?" work across local and remote sessions; with several running it summarises by project.

## Architecture

The voice runs where the AirPods are: the laptop. pi runs on the laptop or on a remote box.

```
AirPods ── laptop voice process (pi-speech)
             │  GPT-Live with client delegation, or today's realtime model
             ├─ local pi: in process (pi-speech is a pi extension)
             ├─ remote pi via pi-mobile's machine link (structured events, dialogs)  ← preferred
             └─ remote pi via herdr CLI (prompt / wait / read)                       ← fallback
```

| pi side | Voice model event (GPT-Live) |
|---|---|
| A complete spoken request → a pi prompt | `session.delegation.created` + the input transcript |
| A request that points at something to come → parked in the editor | a `park` tool: the spoken words go to the editor, the voice stays silent |
| pi progress, tool activity, what is on screen, typed messages | `session.thinking.append` (known, not spoken) |
| The spoken sentence of an answer, a question, a failed significant action | `session.commentary.append`, held until a typing pause |
| "Stop talking", quiet switched on | `session.instructions.append` |

New pieces:
- **Parking.** The `park` tool, plus a local check for trailing pointing words ("following", "this", "these", a final "to" or "as"), so parking does not depend on the model alone. Shown as a marked segment in pi's editor (`ctx.ui.setEditorText` plus a widget for the marker and hint).
- **The said line.** pi's answer gets its spoken sentence as a first line; the brief writer exists (`speech.ts`).
- **The typing gate.** Speech is held while keys arrive (`ctx.ui.onTerminalInput`), questions and failures excepted.

Model: the same realtime API and ChatGPT sign-in as pi-mobile's voice mode (`gpt-realtime-2`, `realtime.ts`): `ask_pi` and a `park` tool, pi's events injected as context, soft barge-in handled client-side. The GPT-Live events in the table are the equivalent if it is ever adopted; nothing in the rules needs it. GPT-Live would add true full duplex (backchannels while listening) but needs an OpenAI API key and is billed per second.

Transport: WebRTC from Node with `werift` (pure TypeScript, no native build; ~8 MB, ~28 packages installed). Spike 2026-10-11 with the ChatGPT sign-in: `gpt-realtime-2` over `chatgpt.com/backend-api/codex/realtime/calls` connected from Node, the data channel opened, and the model spoke (429 audio packets, the full event stream). WebSocket on `chatgpt.com` (`/codex/realtime`, `/codex/live`) is refused by Cloudflare (HTTP 403 page); Codex itself uses WebSocket only with an API key.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Infer where the developer is looking (terminal focus, typing, AirPods) and change what is spoken | Unpredictable: the same answer is spoken one time and silent the next. Draft v1 of this design; dropped. |
| Fixed voice-chat and commentary modes (ChatGPT Voice, Heard) | Kept only as the two explicit switches; everything else follows one rule. |
| Captions of the speech in the TUI | Duplicates pi's text (Kazoo's "transcript echo"). Only the one spoken sentence is shown, as the answer's first line. |
| Merge speech and typing silently within a time window | Invisible and surprising when it misfires. Parking in the editor shows the merge before it is sent. |
| One speech-to-speech model that also drives pi's tools | Hallucinates project facts (Kazoo); pi is the agent, the voice is the conversation. |

## Non-goals

- Echo cancellation for laptop speakers (headphones assumed; speakers fall back to push-to-talk).
- The voice model's own tools or web search.
- Spoken references that highlight items on screen; possibly later.

## Open questions

1. GPT-Live with the ChatGPT sign-in: the endpoint accepts the call (`?intent=quicksilver&architecture=avas`, `OpenAI-Alpha: quicksilver=v2`, `model: gpt-live-1-codex`, `delegation: {type: "client"}`) and connects, then closes with "Voice session access denied." Likely gated to Codex's own clients or by plan; not pursued further. GPT-Live therefore needs an API key.
2. ~~Can an extension show a marked spoken segment inside pi's editor?~~ Yes: `ctx.ui.setEditorComponent` with `CustomEditor` replaces the editor while keeping pi's shortcuts; the full-screen draft view is a `ctx.ui.custom()` overlay sized to the terminal minus the footer (to confirm in the prototype that the footer stays visible and pi's own redraws don't fight it).
3. Remote sessions: how does a remote pi's editor show a parked request, given the voice runs on the laptop? Through the machine link's editor commands, or the laptop keeps the parked text and pastes on Enter.
4. Typing-pause length and the parking word list are starting values to tune.

## How we'll know it works

- After one session, a developer predicts correctly, for a list of ten pi events, which are spoken.
- "Rename it to the following" + typed `foo.ts` + Enter produces one pi message containing `foo.ts` exactly, on the first try, without explanation.
- No speech starts within a second of a key press, except questions and failures.
- A question needing current information is passed to pi every time.
- Spoken words per completed task drop compared with today's voice mode, without more "what?" or scrolling back.
