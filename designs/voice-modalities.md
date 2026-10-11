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
2. Can an extension show a marked spoken segment *inside* pi's editor, or only beside it (a widget above the editor)? Decides how rule 2 looks.
3. Remote sessions: how does a remote pi's editor show a parked request, given the voice runs on the laptop? Through the machine link's editor commands, or the laptop keeps the parked text and pastes on Enter.
4. Typing-pause length and the parking word list are starting values to tune.

## How we'll know it works

- After one session, a developer predicts correctly, for a list of ten pi events, which are spoken.
- "Rename it to the following" + typed `foo.ts` + Enter produces one pi message containing `foo.ts` exactly, on the first try, without explanation.
- No speech starts within a second of a key press, except questions and failures.
- A question needing current information is passed to pi every time.
- Spoken words per completed task drop compared with today's voice mode, without more "what?" or scrolling back.
