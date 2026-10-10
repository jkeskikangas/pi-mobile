# pi-mobile

A pi extension: an end-to-end encrypted hub inside pi plus a no-build phone web app (`web/`), with voice input and voice mode. Overview and usage: `README.md`.

## Commands

- `npm install`, `npm test` (node test runner, `test/*.test.ts`), `npm run typecheck`.
- Try it: `pi -e ./src/index.ts`, then `/remote`.
- Browser end-to-end checks (need a running pi and Playwright): `test/e2e/` (see `docs/voice.md` → Verification).

## Read before changing

- **Any UI in `web/`**: `docs/ui.md` (the design system: tokens, components, patterns, past mistakes; `npm run ui` and `npm run shots` checks) and `docs/design-principles.md` (why it works this way, dictation and voice surfaces, motion, copy, what "done" means).
- **Voice** (`src/voice/`, `web/voice*.js`): `docs/voice.md` (design, verification), `docs/voice-best-practices.md` (each practice, why, references) and the research notes `docs/voice-research.md`, `docs/voice-research-2.md`.
- **Multi-machine work** (`web/fleet.js`, `bin/pi-mobile.mjs`, offers in `src/hub.ts`): `specs/`, `designs/`, `plans/multi-machine.md`. `bin/` stays dependency-free JavaScript: it runs via `npx` on a fresh box.
- **Native apps** (`native/`): `plans/native-apps.md` and `docs/native-research.md`.
