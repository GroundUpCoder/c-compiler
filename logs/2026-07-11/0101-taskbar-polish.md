# 0101 — taskbar polish: strip menu, Show Desktop, clock date

Landed the rest of the taskbar (0091 owns the button right-click; this owns
everything else on the bar). All in `os/wm.c`; image bumped **v60 → v61**
(seeded `wm.c` changed). No kernel/protocol change — it's all wm.c policy
over the existing WMP client surface.

## What shipped

Three pieces, plus the right-button plumbing they all needed:

1. **Taskbar-strip menu** (`ctx_open_taskbar`). Right-clicking the strip —
   the empty run, the clock cell, or the Show Desktop region, i.e. anything
   past the Start strip that isn't a *drawn* button — raises a Win95 bar
   menu over the **same 0091 borderless-popup furniture** (top layer, root
   holds focus, outside-click/Esc/EV_SCREEN dismiss, arrow/Enter nav). Rows:
   Cascade, Tile, Minimize All, Properties (→ the ctlpanel hub, the 0089
   argv path). Four new command ids (`CM_CASCADE/TILE/MIN_ALL/PROPERTIES`)
   in the shared `ctx_activate` dispatch.

   - **Cascade** (`cascade_windows` → `cascade_one`): every visible window
     to a diagonal slot; resizable ones also RESIZE to a uniform 3/5 box,
     fixed-size ones are MOVE-only (never sheared — the 0021 rule).
   - **Tile** (`tile_windows`): the resizable visible windows into a
     near-square grid (`rows = isqrt(nt)`, `cols = ceil(nt/rows)`) filling
     the work area; fixed-size windows can't fill a cell without shearing,
     so they get cascaded positions instead. No resizable window (or a
     too-cramped grid, cells < 96px) falls back to a plain cascade.

2. **Show Desktop** — a narrow `SHOWDESK_W` (14px) sliver at the far right,
   *past* the clock. The clock's right budget therefore moved from
   `bar_w - CLOCK_W` to `clock_left() = bar_w - SHOWDESK_W - CLOCK_W`, and
   every gate that referenced the old budget (btn_width, bar_motion,
   bar_click, bar_rclick, draw_bar) now goes through `clock_left()`. The
   sliver toggles minimize-all / restore: `min_all()` stashes the sids it
   minimized (`sd_stash`, **by sid** — wins[] indices aren't stable across
   creates/closes), and `show_desktop_toggle()` restores exactly that set
   on the next click. Windows minimized *before* the toggle are never in
   the stash, so they stay down across a restore (the Win7 rule). "Minimize
   All" in the strip menu is `min_all()` directly. The sliver draws pressed
   (170,170,170) while a stash is held.

3. **Clock date tooltip** — a `DATE_W`×`DATE_H` (104×22) borderless
   top-layer **"datepop"** window (the Aero-Peek furniture mechanism, not a
   native tooltip), light-yellow face, showing `WDY YYYY-MM-DD`. Hovering
   the clock raises it *unpinned* (idle-dismissed by the frame loop like
   peek's PEEK_IDLE backstop, since the wm only sees motion over its own
   windows); clicking the clock **toggles** it *pinned* (stays until clicked
   away — the agent/touch-parity path). Parks + focus-hand-back in
   `handle_event`'s EV_CREATED like every other furniture window; dismissed
   by `screen_changed`/`saver_show` alongside the other popups.

Right-button routing: the frame-loop dispatch already had `bar_rclick` on
`e.button.button == 3` (0091); `bar_rclick` grew the strip-menu branch.
Left-click (`bar_click`) is byte-identical except the two new far-right
regions (clock → `date_toggle`, sliver → `show_desktop_toggle`) short-
circuit before the button-hit math.

## Gotchas hit

- **The context-menu height is `2*MENU_PAD + Σrows`, not just Σrows.** My
  first test assertion used 88 (4×20 + 8 sep) for the 5-row strip menu; the
  real height is 96 (+8 for top/bottom pad). The button menu is the same
  96 — the 0091 test already encoded that, I just misread it.
- **The existing `test_wm_service_e2e.js` clicks x=1000 to prove "clock cell
  hits no button".** With 0101 that left-click now *toggles the date
  tooltip*, and a pinned datepop lingers on the top layer — which broke the
  later z-order leg (raised winbox must sit directly below the bar; the
  datepop wedged between). Fix: toggle it back off right after that leg. The
  window is still untouched, so the leg's own assertion is unchanged.
- **`os-shell.mjs`'s clock histogram sampled `[SW-45, …]`.** The clock moved
  14px left; updated to `[SW-14-45, …]`. (Necessary correctness fix even
  though the browser sweep is manual.)
- **Right-clicking the strip at a fixed x is unsafe** when many windows fill
  the button run — x could land on a button. The e2e right-clicks the clock
  cell (x=970 @1024 wide, always past the buttons whatever the count); the
  strip menu clamps to the right edge (`x = scr_w - CTX_W`).

## Testing

- `node tests/kernel/run.js` → **53 passed, 0 failed** over a fresh v61 bake.
- New 0101 legs in `test_wm_service_e2e.js`: strip-menu open geometry
  (120×96 clamped above the bar), Minimize All minimizes both fresh
  winboxes + dismisses, Show Desktop toggle down/up/down, Cascade resizes to
  the uniform 614×427 box at distinct origins, datepop raise/shot/toggle-off.
- `test_ctxmenu_e2e.js` updated: the empty-bar right-click that used to
  assert "reserved" now targets the Start strip (the surviving reserved
  slot); the button-menu legs are unchanged.
- `tests/browser/os-shell.mjs` grew a taskbar-local 0101 leg (strip-menu
  face, clock datepop face, Show Desktop sliver pressed/raised). **Not run
  this session** — playwright isn't installed in this environment; it's the
  operator's manual browser tier (`node tests/browser/os-sweep.mjs`).

Non-goals recorded, not built: Quick Launch icon strip, notification tray /
balloons, taskbar button grouping, moving/locking the bar to other edges.
