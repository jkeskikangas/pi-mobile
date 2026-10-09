# Phone UI

The phone app is plain HTML, CSS and JavaScript in `web/` (no build step). This page records the design system so changes stay consistent.

## Principles

- **The conversation is the surface.** Assistant text sits flush on the page; your messages are soft accent bubbles. Everything else is quieter than the words.
- **Steps, not boxes.** Tool calls are single rows: icon, verb, target, status. Details open on tap; failures show their output without a tap.
- **Say what is happening in words.** The header's second line is the session's state ("Working · 0:42", "Needs you · Allow tofu apply?"); colour only reinforces it.
- **pi's questions win.** An open question is a raised card above the composer with full-width answers; other sessions' questions appear as one bar under the header.
- **One thumb.** Every control is at least 44 px; primary actions sit at the bottom; toasts drop in under the header so they never cover controls.

## Tokens (`web/app.css` `:root`)

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--surface`, `--panel-2`, `--fill-2`, `--code-bg` |
| Text | `--text`, `--text-2` (secondary), `--muted` (tertiary; ≥ 4.5:1 on `--panel-2`) |
| Lines | `--border`, `--border-strong` |
| Accent | `--accent`, `--accent-text`, `--accent-soft`, `--accent-ink` |
| Status | `--ok`, `--warn` (text), `--warn-dot`, `--warn-soft`, `--warn-line`, `--err`, `--err-soft` |
| Diff | `--add`, `--add-ink`, `--del`, `--del-ink` |
| Shape | `--r-s` 8, `--r-m` 12, `--r-l` 18, `--r-xl` 24; `--shadow-1`, `--shadow-2`; `--ease` |

Light and dark themes redefine the same tokens; components use tokens only. Icons come from the SVG sprite in `web/index.html` (`icon(name)` in `app.js`), drawn on a 24 px grid with 1.9 px strokes.

## Checks

`npm run ui` starts a hub with scripted sessions (rich transcript, running tools, diffs, questions, several sessions) and prints a pairing link; type `work`, `ask`, `pick`, `done` on its stdin to move through states. Every state should pass an axe WCAG 2.2 AA scan in light and dark at 390 px and 320 px, work by keyboard alone, and honour reduced motion and forced colours.
