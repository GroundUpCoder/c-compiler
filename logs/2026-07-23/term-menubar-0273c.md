# 0273 child (c) — term menu bar: implementation log

**Branch**: `term-menubar-0273c` (base `origin/main` @ 6c3c39f). Design note
(fork analysis + the checkpoint stop): `term-menubar-0273c-design.md` in this
folder. @master green-lit path (A) — term as **menucore customer #3**.

## What landed

`/bin/term` grew a macOS-Terminal-style top menu bar riding the OS's ONE menu
facility at both layers:

- **The strip** is a persistent `"menubar"` anchored-child window
  (`SDL_CreatePopupWindow(win, 0, 0, w, MENU_BAR_H, SDL_WINDOW_TOOLTIP)` —
  the 0256 kernel primitive; user32's own bar has been this exact shape since
  0257). Painted through `__gdi_dc_wrap` in the engine's font/colors
  (BTNFACE/BTNTEXT/HIGHLIGHT), presented only on menu-state changes.
- **The dropdowns** are menucore-ENGINE chain levels: term links
  `os/win32/menucore.json` (menucore.c + gdi32.c + freetype — freetype was
  already term's dep) and instantiates the `MenuCoreOps` vtable exactly like
  wm.c (customer #2) and user32 (#1). Levels are real `SDL_WINDOW_POPUP_MENU`
  anchored children titled `"#32768"`, so they hold the kernel grab
  (outside-press dismissal via CLOSE_REQUESTED, press consumed) and
  `wmctl wait win "#32768"` works on term's menus exactly as on notepad's.
  Zero menu geometry/tracking/keyboard/paint logic lives in term.
- **Menu tree** (scoped to actions real today):
  - *Shell*: New Window (posix_spawnp an independent sibling `/bin/term`,
    own pgroup, pty master closed in the child via file-actions — a second
    master holder would defeat master-close EOF; reaped by the frame_cb
    WNOHANG loop) · **Settings… GRAYED stub** — the 0273(d) settings-lane
    entry point, visible but inert until (d) lands (explicit deferral) ·
    separator · Close Window (`exit(0)`; master close HUPs the session).
  - *Edit*: Copy / Paste / Select All over the 0090 handlers; Copy/Paste
    live-grayed (`sel_on` / `SDL_HasClipboardText`) in the `popup_opening`
    op — the WM_INITMENUPOPUP analog, fired before the level is measured.
  - *View*: Scroll to Top / Scroll to Bottom / separator / Clear Scrollback
    over the 0273a scrollback model, grayed on the alt screen and at the
    respective limits.
  - **Deferred explicitly** (not silently cut): a Window menu
    (Minimize/Zoom) needs WMP chrome ops term doesn't speak (not a wm.sock
    client); Help needs dialog furniture term doesn't have; accelerator
    display waits for (d)/keys.h wiring (items carry no accel text they
    don't honour); keyboard bar activation (macOS Ctrl+F2) not wired —
    menus open by pointer (+ wmctl injection).
- **Geometry**: the window grew to `cols*cell_w × (MENU_BAR_H + rows*cell_h)`
  — 640×486 — so the 80×24 grid contract is untouched; the grid renders at
  y-offset `GRID_Y` (=MENU_BAR_H=30), selection/scrollbar input math shifts
  with it, and the 0273b scrollbar spans the grid band only. Resize keeps
  the A5 rule: the strip width-follows the parent via `SDL_SetWindowSize`,
  repainting on its own RESIZED ack.
- **Modality**: while a chain is open, keys drive `mc_route_key` (+
  `mc_typeahead`) and are swallowed — browsing a menu can never type into
  the pty or snap the scrollback view; a main-window press closes the chain
  (the in-window twin of the kernel grab). The pty keeps draining and the
  grid keeps rendering under an open menu (levels are separate surfaces).

## Two non-obvious integration facts (worth remembering)

1. **`mc_fire` posts a bar-tracking's command only `if (owner)`** — the
   owner token passed to `mc_track_begin` must be non-NULL (wm.c passes its
   vtable address; term now does the same). With NULL the chain closes but
   the item silently never fires — caught by the e2e's New-Window leg.
2. **The close box stops arriving as `SDL_EVENT_QUIT`.** `__sdl_push_quit_event`
   (todos/0089) delivers per-window `SDL_EVENT_WINDOW_CLOSE_REQUESTED` when
   more than one window is live — and with the bar strip child, term is
   always multi-window now. term handles the main window's close request as
   session end (the nested-session "close box reclaims the orphan" leg
   caught this).

## Binary / diff surface

- term.wasm 400,307 → 432,614 bytes (+32.3 KB, +8.1%) — the 0214 tree-shake
  keeps the unused bulk of gdi32 out.
- `os/term/bin.json`: +1 dep (`../win32/menucore.json`).
- `os/term/term.c`: +~420 lines (menu section: tree build, ops vtable, bar
  furniture, event demux) + GRID_Y offsets in render/input/resize + the
  multi-window close handler + the generalized WNOHANG reap loop.
- No changes to kernel.js, the SDL veneer, menucore.c, gdi32.c, user32.c,
  wm.c, or any header. No new kernel/SDL surface.

## Goldens / test rebaselines — every moved constant, and why

The bar is ALWAYS-ON (macOS Terminal reference; an off-mode would be a
zombie fallback), so term-geometry assertions shift once, deliberately:

- `tests/kernel/test_term_e2e.js`: window checks 640x456 → 640x486; all PPM
  dim checks likewise; a shared `GRID_Y = 30` constant added — row-0/cell
  ink probes (`row0Ink`, `cellInk`, the vi middle-band) sample
  `y ∈ [GRID_Y, GRID_Y+19)` instead of `[0,19)` (same logical rows, shifted
  by the bar); the unicode selection drag y 9 → 39 (row-0 center below the
  band); the scrollbar thumb-press y 446 → 476 (thumb bottom now 486) and
  drag target y 2 → 32 (grid-band top); scrollbar bright-region windows
  offset by GRID_Y. The 500x260 resize leg is unchanged (the grid just
  reflows to 62×12 under the bar).
- `tests/kernel/test_clipboard_e2e.js`: the whole-screen drag-selection
  4,4→636,428 becomes 4,34→636,480 (grid band).
- `tests/browser/os-term.mjs`: `TH` 456 → 486; the banner and post-resize
  `waitBright` regions start at `TY+30` (the bar band is uniformly bright
  BTNFACE and would satisfy the thresholds on its own — shifting keeps the
  checks meaningful); new leg: BTNFACE band pixel probe, real-mouse bar
  click opens `"#32768"` (verified over VT1 wmctl), canvas-dispatched Esc
  dismisses it.
- `tests/kernel/test_fontpkg_e2e.js`: the CJK cell-pair probe (`pairBits`)
  sampled row 0 at y 0..19 — shifted to `GRID_Y + y` (found by the full
  suite run, the one rebaseline the pre-sweep grep missed: it hardcoded
  `19` loops rather than naming 456/640).
- No committed image goldens reference term pixels; `test_wm_policy.js`'s
  `456`s are unrelated fake-window coords (checked, untouched).

New e2e session `menubar` in `test_term_e2e.js` (all REAL-path):
bar-child click opens Shell → `wait win "#32768"` → engine-painted level
shot → item click fires New Window (independent sibling term appears) →
kernel-grab outside-press dismissal via `wmctl sdown` (full wmPointer
path) → Esc dismissal (modal engine keys) → metrics-independent hover
sweep switches titles to View → Down+Enter fires Scroll to Top (the 0273a
marker row appears at the grid top).

## Gate results (from the worktree, final tree)

- term e2e: all 9 sessions green (run as sub-600s batches: term+frames,
  nested+less, unicode+wide, scrollback+scrollbar, menubar).
- New `menubar` session: **5/5 isolated** (plus the batch runs).
- Flake tripwire: `run.js --filter=term_e2e --repeat 3 --under-load` →
  **3/3 stable, flake 0%** (under load ×10).
- Full kernel suite: **103 passed, 0 failed** (455s) — wm_service green;
  `test_clang_pkgs_e2e` passed in-suite this round and isolated (the
  pre-known -j4 dist/packages race did not trigger). An earlier full run
  before the fontpkg rebaseline was 101/103, the two being fontpkg (mine,
  fixed above) and clang_pkgs (the known race, passes isolated).
- clipboard e2e: green (term drag-selection leg rebaselined).
- Browser: `os-sweep --filter=os-term` → 15/15 incl. the three new menu
  checks (BTNFACE strip composited, real-mouse bar click opens "#32768"
  verified over VT1 wmctl, canvas-dispatched Esc dismisses).

## Fix-log during the gate (both engine-integration facts above)

- `mc_track_begin` owner token NULL → items silently never fired (New
  Window leg red) → pass the vtable address, the wm.c pattern.
- Close box arrived as per-window CLOSE_REQUESTED once term became
  multi-window (nested "close box reclaims the orphan" leg red) → handle
  it as session end.
