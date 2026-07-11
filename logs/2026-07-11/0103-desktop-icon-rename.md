# 0103 — desktop icon rename-in-place

Desktop icons had no rename affordance (the only rename path was fileman's
0092 context menu). Added the Win95 inline-editor rename to the desktop layer
in `os/wm.c` — the 0077 selection state made this a clean follow-on.

## What landed

- **Triggers.** F2 on a single-selected icon (`desk_key`), and a new **Rename**
  row on the 0091 icon context menu (`CM_RENAME`, dispatched by `ctx_activate`).
  The click-pause-click gesture the plan listed as *optional* was descoped by
  design — F2 + menu Rename fully cover the rename-in-place intent, and the
  Win95 slow-double-click-to-rename is a well-known foot-gun.
- **Editor.** `desk_edit` holds the `desk[]` index being renamed, `desk_ebuf`
  the working name. `desk_key` gets a modal branch at the top: printable keys
  (32–126) insert, Backspace deletes, Enter commits, Esc cancels, everything
  else is swallowed. `draw_desk` renders a sunken white box + black text + a
  2px caret over the label cell instead of the navy label strip (`continue`
  past the normal label draw). The 5×7 font is uppercase-only, so the box shows
  uppercased text — consistent with every other wm.c label; `rename(2)` stores
  the real bytes regardless.
- **Commit.** `desk_edit_commit` refuses empty / `/`-bearing names (editor stays
  open — the beep-equivalent; wm.c has no dialog furniture), no-ops an unchanged
  name, and `lstat`s the target first to refuse a clobber (EEXIST → both files
  kept, editor stays open). On success it carries the 0077 `.icons` placement to
  the new name (`desk_icons_rename` rewrites the matching `col row name` line in
  place — no-op if the file/entry is absent, so the icon just auto-flows) and
  reloads. `desk_load` and `make_desk` bail / reset while an edit is live so the
  edited index can't go stale under the ~1s re-read tick or an EV_SCREEN recreate.
- **Click-away / focus-loss commit.** A desktop left-click calls
  `desk_edit_finish` (commit-if-valid-else-discard) before processing the click;
  losing desktop focus does the same.

## The focus-race gotcha (the one real subtlety)

The icon-menu Rename path dismisses the ctxmenu (which held kernel focus) then
opens the editor and re-focuses the desktop. The teardown can emit a **transient
EV_FOCUS to some app window** before our `WMP_FOCUS(desk_sid)` lands — and a
naive focus-loss commit would see `desk_focused` drop to 0 and close the
just-opened editor (the seeded buffer == the name, so it commits as a no-op and
vanishes) *before the user types anything*.

Fix: a `desk_edit_armed` flag. `desk_edit_start` sets `armed = desk_focused` —
the F2 path (desktop already focused, no focus change coming) arms immediately;
the menu path (`desk_focused == 0`, the ctxmenu had it) arms only when our
`WMP_FOCUS`'s **EV_FOCUS(desk)** actually lands, not on the dismiss fall.
Focus-loss commit is gated on `armed`, so the spurious mid-open EV_FOCUS is
ignored. Verified by the `test_wm_service_e2e.js` icon-menu leg (aab → mmm),
which would fail if the editor closed early.

## Tests

- **Headless** (`test_wm_service_e2e.js`, new rename leg): two fresh `aa*` files
  that sort before every seeded icon make the top-left cell deterministic
  despite the earlier grid churn (no pixel math — `rm .icons`, empty-cell click
  to focus, Right selects top-left, F2 edits). Covers F2 rename (aaa→zzz),
  EEXIST-keeps-both, Esc-cancel-untouched, and the icon-menu Rename path.
- **Browser** (`os-shell.mjs`, operator-run): `aaa` seeded top-left, F2 opens
  the white editor box (teal→white pixel transition), retype → the grid
  relabels, verified on disk (aaa gone, bbb present).
- Geometry bumps: the icon menu grew a row, 120x96 → **120x116** —
  `test_ctxmenu_e2e.js` and `test_recycle_e2e.js` updated (DELETE's row Y is
  unchanged, so their DELETE clicks still land).
- `node tests/kernel/run.js` → 53/0 over a fresh v63 bake.

Image bumped **v62 → v63** (seeded `wm.c` changed).
