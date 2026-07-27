# 0272 — MagicPointPlus: a fork of /bin/mgp with click-to-go-back + arrow-key nav

- **Status**: done (user-requested 2026-07-21)
- **Design**: — (MagicPoint port shipped as 0119, `todos/done/0119-magicpoint-presentations.md`; source `vendor/magicpoint/mgp.c`, whitelist/render polish 0202)
- **Difficulty**: light

## Goal

Ship **MagicPointPlus** — a fork of the MagicPoint viewer (`/bin/mgp`,
`vendor/magicpoint/mgp.c`) that keeps every existing behaviour but adds three
navigation conveniences the user wants:

1. **Click on the LEFT half of the slide → go BACKWARD** (previous page)
   instead of forward. Click on the right half stays forward. (Today any
   click / space advances one page — see the deck footer "space / click:
   next page   b: back   q: quit".)
2. **Left arrow → back, Right arrow → forward.** Today only `b` goes back and
   space/click goes forward; the arrow keys are not bound.
3. Everything else — `space` (next), `b` (back), `q` (quit), the `%`-directive
   render set, the 0202 whitelist — unchanged.

## Notes / scope

- The user asked for a **fork** ("MagicPointPlus"), i.e. a distinct app, not a
  behaviour change to `/bin/mgp`. Honour that: new binary (e.g. `/bin/mgpp`),
  its own `bin.json`, its own desktop/registry entry and file-association so
  `.mgp` decks can open in either viewer. Keep the fork a THIN delta over
  `mgp.c` — share as much source as is clean (a compile-time flag or a small
  shared core is preferable to a full copy that drifts; decide at design time,
  but do not silently duplicate 1000+ lines that will diverge like the
  emulator-frontend rot the arch-debt scan flagged).
- Left/right hit-test is on the slide's rendered width; use the same
  event/geometry the current click-advance path already reads (find the
  mouse-click page-advance handler in `mgp.c`).
- If, at design time, hosting both behaviours as a *mode* inside the single
  `mgp` binary turns out materially cleaner than a second binary AND still
  satisfies "MagicPointPlus is its own thing" (own launcher/name), surface
  that to the user before forking — but the default per the ask is a fork.

## Acceptance

- `/bin/mgpp <deck>.mgp` opens the same decks `/bin/mgp` does and renders
  identically.
- Clicking the left half of a slide goes to the previous page (clamped at
  page 1); clicking the right half advances (clamped at last page).
- Left/Right arrow keys page back/forward; `space`/`b`/`q` still work.
- A headless/e2e leg (or `os-*.mjs` browser leg) that opens a multi-page deck,
  left-clicks and asserts the page index decremented, right-clicks/arrows and
  asserts it moved the expected direction.
- MagicPointPlus is launchable from the desktop / has a `.mgp` association so
  the user can pick it.
