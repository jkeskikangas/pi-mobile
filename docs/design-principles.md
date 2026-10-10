# Frontend design principles

For anyone, person or agent, changing the phone app in `web/`. Read with [ui.md](ui.md), which is the source of truth for **tokens, icons and the UI checks** (`npm run ui`). This page explains **why** the app looks and behaves the way it does, how the voice surfaces work, and what "done" means for a UI change. Where the two overlap, `ui.md` wins on tokens and this page on behaviour.

The app is plain HTML, CSS and JavaScript (`index.html`, `app.css`, `app.js`, `voice.js`, `voice-core.js`) served by the hub under a strict CSP. No framework, no build step, no dependencies. Keep it that way.

**The product in one line: pi on your phone, used in glances and by voice, by someone whose attention is mostly elsewhere.** Every rule below follows from that.

## 1. Who is holding the phone

| Moment | Attention | Design for |
|---|---|---|
| The locked phone buzzes: "api asks: Allow file change?" | 2 seconds | One tap from the notification to the answer. The question card is the first thing on screen. |
| Checking on a run | 10–30 seconds, one hand | The header says the state in words; the latest reply is visible without scrolling. |
| Steering from the sofa | minutes, typing or dictating | A composer that never fights you; dictation that writes what you meant. |
| Running, cycling, driving, cooking | eyes and hands busy | Voice mode: sound and speech first; the screen is a backup you can hit without looking. |

If a change only works with full attention and two hands, it is wrong for this app.

## 2. Principles

`ui.md` lists the visual ones (the conversation is the surface, steps not boxes, say what is happening in words, pi's questions win, one thumb). These add the behavioural ones:

1. **What needs you comes first.** A waiting question outranks everything: the raised question card, the bar for other sessions' questions, the session list grouped Needs you → Working → Idle. Never put a waiting dialog behind navigation.
2. **One obvious action per state.** Each state has a single primary action (accent fill, at the bottom). Secondary actions are quieter. Destructive answers are red and name what they do ("Yes, do it", "Revoke"), never a bare "OK".
3. **State in words, colour and sound.** The header says "Working · 0:42"; status dots reinforce it; voice states also have an earcon. Never colour alone.
4. **One colour language, everywhere.** A colour means the same thing in the app, in dictation and in voice mode: **blue** is you and what you can tap (your messages, the recorder, listening, primary buttons), **violet** is pi working (the "Working" status, running steps, distilling, the working orb), **teal** is pi speaking, **amber** is pi needing you, **green** is done, **red** is stop, failure and irreversible answers, **grey** is off. The tokens are `--you`, `--busy`, `--speak`, `--needs`, `--ok`, `--danger`/`--err` and `--off` (`ui.md`).
5. **Nothing is lost.** Text survives reconnects; dictation offers raw and undo; irreversible voice confirmations have an undo window; errors say what to do next.
6. **Calm by default.** A toast or an inline line before a modal; a state label before a spinner; animation explains state, never decorates.
7. **One truth.** The terminal, the phone and the voice say the same thing about a session: voice mode's header shows the app's own status line (`statusLine` in `app.js`). The phone never invents state the hub did not send.
8. **Tokens only.** Every colour, radius, shadow and easing comes from the tokens in `ui.md`. Voice mode follows the system theme like every other view, so its header, question card and segmented controls are the app's components; only the orb draws with the vivid `--d-*` state colours in both themes.
9. **One component per job.** A question from pi is the `.prompt` card wherever it appears (transcript or voice mode); a two-way choice is `.seg`; a session header is `.session-btn`. Do not restyle a copy; extend the component.

## 3. Dictation in the composer

- The mic sits next to Send. **Hold to talk, release to finish** (walkie-talkie); a quick tap toggles and you finish with ✓. Enter or Space toggles from the keyboard. No long-press menu or text selection on the button.
- While recording, `#dictBar` becomes the recorder, in "you" blue like voice mode listening: cancel ✕, a live waveform, a timer, a one-line hint, done ✓. It is built once and animated per frame; never rebuild DOM on a timer. Distilling shows pi's violet spinner.
- The result lands in the input **for review**; the phone never sends a dictation by itself. Chips: **raw** (toggles to **distilled**) and **undo**, with one status line ("Distilled from your speech — check it, then send").
- Busy and error states say what is happening and what to do ("Didn't catch anything. Try again a little closer to the mic.").
- What the user changes before sending teaches the personal dictionary (`docs/voice.md`); keep the send path calling `learn`.

## 4. The voice screen

Voice mode exists for eyes-busy use. The screen is glanced at or hit blindly; sound and speech do the real work (behaviour in [voice.md](voice.md)).

- **Immersive, in either theme.** Voice mode follows the system theme like the rest of the app (a dark room or a sunny street both get a legible screen). The orb keeps its vivid state colours (`--d-accent`, `--d-busy`, `--d-speak`, …) in both themes, so a state looks the same wherever you see it.
- **The header is the app's header**: session name, the app's status line ("Working · 0:42", "Needs you · …") and status dot, plus the engine tag when voice runs without realtime.
- **State colours** come from `.voice[data-state]` as `--c1`/`--c2` (pairs of the vivid `--d-*` state colours) and drive the glow and the orb, in the same colour language as the app:

  | State | Colour | Label |
  |---|---|---|
  | listening, hearing | blue (`--you`) | Listening |
  | thinking | blue → violet | Got it |
  | working | violet (`--busy`) | pi is on it, with elapsed time |
  | speaking | teal (`--speak`) | none (the captions carry it) |
  | asking | amber (`--needs`), pulsing ring | pi needs you |
  | paused, connecting, offline | grey (`--off`) | Mic off / Push to talk / Connecting… |

- **The orb** (`Orb` in `voice.js`, a canvas) follows the voice that matters: yours while listening, pi's while speaking; it breathes while pi works. It is `aria-hidden`; the state label is the accessible truth. Draw only in `requestAnimationFrame`, and stop when hidden.
- **The stage is one button.** It interrupts pi, unmutes, or talks (tap mode); its `aria-label` names the action it will take now.
- **Captions** show what you said (muted, "You") and what pi says, live as words arrive. Clamp lines; never scroll.
- **The question card** (`#vAsk`) is the app's `.prompt` card: "pi asks", the title, the message, tap answers when you can glance; destructive answers are `.danger` ("Yes, do it") in both places. During the undo window it shows "Going ahead", the action, a shrinking amber bar, Cancel (primary) and Do it now.
- **Controls at the bottom**: a 64–72 px mute button and two full-width `.seg.wide` segmented controls (Eyes-free | Can glance, Open mic | Push to talk) with `aria-pressed`. Header: session switcher and a 44 px close. Icons come from the app's sprite.
- **Sound is part of the UI.** Earcons live in `voice-core.js` `EARCONS` (listen, heard, working tick, attention, done, failed, off). A new state the user must notice gets a sound, not only a colour; keep the set small so each stays learnable.

## 5. Motion

- Short and purposeful: 100–300 ms with `--ease` for state changes. Loops only for live states (recording ring, working pulse, orb).
- Animate `transform` and `opacity`. Canvas animation runs in `requestAnimationFrame` and stops when the page is hidden.
- No layout shift while content streams: reserve space (captions have a minimum height; the dictation bar replaces itself in place).
- Every animation has a `prefers-reduced-motion` path: no pulsing, breathing, wobble or rings; the orb becomes a still disc that scales only slightly with level.

## 6. Copy

- Plain, short, concrete, second person. Say what happened and what to do: "Voice needs a secure address" plus the exact command, not "NotAllowedError".
- Use the user's words ("session", "phone", "computer"), never internals ("bridge", "hub", "agent id").
- Buttons are verbs or the answer itself ("Yes, do it", "Cancel", "Pair another device").
- Spoken and voice-screen copy follows `voice.md`: outcome first, no identifiers or tool chatter.

## 7. Platform rules

- **iOS**: inputs at 16 px or more (smaller zooms the page); safe-area insets on every fixed edge; `navigator.vibrate` does nothing, so never rely on haptics; the mic needs HTTPS and stops when the screen locks; Web Push needs the Home Screen app.
- **CSP** (`src/hub.ts`): `default-src 'self'`, images `data:`/`blob:`, media `blob:`. No inline scripts, external fonts, scripts or CDNs.
- **Performance**: instant on a mid-range phone over a tunnel. Batch DOM writes, render streams on a timer, no layout reads in per-frame loops.
- **Logic that can be pure belongs in a testable module** (`web/voice-core.js` is loaded by both the browser and `node --test`).

## 8. Done means

1. Every state of what you changed exists and looks right, in light and dark (voice: dark), at 390 px and 320 px. `npm run ui` gives scripted sessions for this; `test/e2e/browser.mjs` and `test/e2e/turns.mjs` drive the app headless, including a fake or scripted microphone.
2. The checks in `ui.md` pass: axe WCAG 2.2 AA, keyboard only, reduced motion, forced colours.
3. Targets are at least 44 px; the primary action is at the bottom and unique in its state.
4. Only tokens: no raw colours, radii, shadows or easings (outside the voice palette).
5. Copy reviewed against §6; nothing internal leaks into the UI.
6. `npm test` and `npm run typecheck` pass.
