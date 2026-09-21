# 0202 — MagicPoint: learn-mgp tutorial series + double-click view + right-click edit

- **Status**: done (2026-07-15) — ten-deck tutorial series seeded (masters /usr/share/mgp/tutorial + rw copies in Desktop/Presentations, image v96), dblclick->viewer verified both surfaces, Edit rows landed (ow_editor; fileman + document desktop icons), kernel32 OPEN_ALWAYS RO-volume fix; log: logs/2026-07-15/magicpoint-tutorials-0202.md
- **Design**: vendor/magicpoint/README.md (0119 port + descopes), todos/0185 (Presentations showcase)

## Goal

Turn the desktop "Presentations" folder into a genuine learn-MagicPoint
tutorial series (numbered decks, beginner → advanced, teaching ONLY the
directives this port actually renders), verify `.mgp` double-click opens the
viewer from both the desktop and fileman, and add a right-click "Edit" path
that opens a `.mgp` deck in the GUI text editor (notepad).

## Plan

- **A — tutorial decks**: `vendor/magicpoint/decks/tutorial/NN-*.mgp`, baked
  to `/usr/share/mgp/tutorial/`, linked from `/root/Desktop/Presentations/`
  (the 0185 showcase decks stay baked at `/usr/share/mgp/` — the present-e2e
  DECKS loop pins them). Progression: what mgp is / navigation → pages &
  text (size/gap/prefix) → color → alignment/%cont → fonts → bullets &
  tabs → images → backgrounds (%bimage/%bgrad) → builds & columns
  (%pause/%mark/%again) → deck-craft (%default/%tab/%include, style).
  Directive whitelist comes from a draw.c/parse.c audit; descoped features
  taught only as "not in this port".
- **B — double-click view**: already wired (`mgp` key in the baked openwith
  table → `/bin/mgp`); verify desktop dblclick + fileman Open both raise the
  MagicPoint window.
- **C — right-click Edit**: an "Edit" row on wm.c's desktop icon menu and
  fileman's row menu, shown for regular files, launching the openwith
  `default.gui` handler (notepad) with the path — a shared openwith.h helper
  so both surfaces resolve the same table.

## Acceptance

- Tutorial decks render every page without draw-time crashes (present-e2e
  style page-through), teach only supported directives, numbered order.
- Desktop dblclick on a Presentations deck → MagicPoint window; fileman
  Open on a `.mgp` → same.
- Right-click Edit on a `.mgp` (desktop icon + fileman row) → notepad with
  the file loaded.
- Image bakes (version bump), kernel + browser suites green for the touched
  surfaces, close-out log under logs/2026-07-15/.
