# 0273 child (c) — term menu bar: design note (fork resolution)

**Lane**: `term-menubar-0273c` (executor lane; base `origin/main` @ 6c3c39f).
**Status**: DESIGN ONLY — implementation deliberately not started. The lane
brief's conditional checkpoint fired (the recommended path links gdi32, via
`menucore.json`); per the brief that means stop after the design note and
report to @master for review. Everything below is worked out so the green-lit
path is a mechanical continuation.

## 1. The crux question, answered with code

**Can a raw-SDL app call the kernel anchored-child popup primitive directly,
without user32/gdi32?** Yes — this is not an inference, it is the primitive's
own acceptance fixture:

- `tests/kernel/fixtures/menubox/main.c` (todos/0256 Spike-1) is "a
  winbox-class SDL app that exercises the whole kernel primitive through the
  stock SDL3 popup API, with NO user32 and NO menu code" (its own header). It
  creates a persistent full-width TOOLTIP bar strip child, a POPUP_MENU
  dropdown chain (two levels), and relies on the kernel grab's outside-press
  dismissal (`SDL_EVENT_WINDOW_CLOSE_REQUESTED`, press consumed).
- The API surface is `<SDL_popup.h>` (compiler.js ~22255): bone-stock SDL3
  `SDL_CreatePopupWindow` / `SDL_GetDisplayBounds` in their own veneer TU, so
  a binary that never creates popups keeps a byte-identical import table.
  Nothing about it is user32-reachable-only.

So term can ride the primitive directly. That much matches the lane brief's
sketch. What the brief's sketch did NOT anticipate is the next finding.

## 2. The finding that changes the recommendation: the facility has a
##    documented third-consumer seam, and its only dep is one term already has

The 0273 todo mandates the menu bar "ride the anchored-child uniform-menu
facility — NOT a 2nd menu path". Reading the facility's code, the facility is
LAYERED, and the uniform-menu architecture (todos/0257 A7/A13, extracted by
0259 M4) draws its "one menu path" line at the ENGINE, not just at the kernel
primitive:

- `os/win32/menucore.h`: "the ONE menu engine's public surface … model +
  geometry + tracking + raster over HDC … touches the world outside itself
  ONLY through the MenuCoreOps vtable — a real struct-of-fn-pointers, so the
  compiler enforces the boundary instead of a prose promise (A7)." The vtable
  doc explicitly enumerates per-front-end bindings — `win_create` for user32
  IS `SDL_CreatePopupWindow` ("the kernel anchored-child primitive of
  todos/0256, POPUP_MENU levels hold the kernel grab").
- `os/wm.json`: wm.c links `win32/menucore.json` (menucore.c + gdi32.c +
  freetype) — "customer #2 of the engine, no user32/kernel32". wm.c is itself
  an SDL app; its whole ops instance (`wmmc_*`, wm.c:1595-1700) is ~100 lines
  wrapping SDL surfaces via `__gdi_dc_wrap` (win32_internal.h:17 — already
  included by wm.c, an os/ consumer precedent).
- `os/win32/menucore.json` is a lib whose ONLY external dep is
  `vendor/freetype/lib.json` — which term already links for its glyphs.
- menucore.h header comment, on wm.c's old private flyout code: "the fork
  this seam existed to delete, per A13".

**Compile+link probe (verified, then reverted):** adding
`../win32/menucore.json` to `os/term/bin.json` and referencing the engine +
raster symbols from term.c builds clean via os-common `buildProject`:

    baseline term.wasm   400,307 bytes
    + menucore linkage   424,634 bytes   (+24,327, +6.1%)

The 0214 tree-shake keeps unreferenced gdi32 out; the real implementation will
land somewhere between +24 KB and ~+40 KB. windows.h/SDL.h/sys-headers
coexistence in one TU is proven by wm.c's own include list (wm.c:150-185).
Probe harness: `build/probe-term-build.js` (gitignored).

## 3. The three candidate paths

**(B) The lane brief's sketch — primitive + term-private fontcore dropdowns.**
Term calls `SDL_CreatePopupWindow` itself and draws bar + dropdown items via
its fontcore pipeline. Uniform at the kernel-surface level (z-order, grab,
dismissal, anchoring). But everything ABOVE the surface — item-row geometry,
hot-row tracking, hover highlight, gray/separator handling, keyboard nav
(Up/Down/Enter/Esc), paint — would be a term-private reimplementation of what
menucore.c already does, at term's 14px metrics instead of the OS menu's
(MENU_ITEM_H 30, 20px chrome font). That is a menu widget that *happens to
look similar*: the exact fork A13 deleted from wm.c, recreated in a third
place. ~300-400 new lines, none shared. I judge this NOT clean under the
todo's own mandate and the repo's core principle.

**(A) RECOMMENDED — term as menucore customer #3.** Term links
`win32/menucore.json` (the wm.c precedent) and instantiates the ops vtable;
dropdown model/geometry/tracking/raster are the ONE engine, so term's menus
are pixel- and behavior-IDENTICAL to every user32 app's and wm.c's (same
engine raster, same 20px system font, same metrics, same keyboard rules, same
"#32768" window titles for tests). Zero duplicated menu logic; zero new
kernel/SDL_popup surface. Cost: term's build newly includes gdi32.c (inside
menucore.json) — +24 KB verified. This is NOT "pulling the whole
user32/gdi32 stack": no user32, no kernel32, no HWNDs; it is precisely
wm.json's dep line.

**(C) For completeness — link user32 and become a win32 app.** Rejected
without further analysis: term is an SDL/pty app; user32 would fight its
event loop and pty ownership. Nobody proposed this.

**Why (A) over (B), in one sentence:** the 0273b scrollbar lane drew its own
bar because user32's SCROLLBAR control is HWND/GDI-coupled and there was no
engine seam to ride — but for menus the repo BUILT the seam (A7/A13,
MenuCoreOps) exactly so a non-win32 front-end could consume the one engine,
and wm.c already proves the pattern.

**Why this is a checkpoint stop anyway:** the lane brief says "if the ONLY
clean way genuinely requires term to newly link user32/gdi32 … STOP after the
design note and report". Path (A) does newly link gdi32 (via menucore.json).
The brief's PROCEED branch was scoped to "NO new heavy linking" and sketched
fontcore-drawn items — which §3(B) argues is the thing the todo forbids. So:
stopping, with (A) recommended. If @master green-lights (A), §4 is the
implementation plan; if @master prefers (B) after reading §3, the
§4 geometry/menu-tree/test sections apply unchanged (only the drawing/
tracking layer differs).

## 4. Design under (A) — worked to implementation readiness

### 4.1 Geometry

- The bar is a persistent strip child popup — `SDL_CreatePopupWindow(win, 0,
  0, width, MENU_BAR_H, SDL_WINDOW_TOOLTIP)`, title `"menubar"` — identical
  to user32's `menu_bar_sync` (user32.c:1377) and menubox's `mb-bar`.
  MENU_BAR_H = 30 (menucore.h; must agree with the engine).
- Term's window grows by the bar: `SDL_CreateWindow("term", cols*cell_w,
  MENU_BAR_H + rows*cell_h, RESIZABLE)` — the 80x24 grid contract is kept;
  the initial window is 30px taller (640x486 at today's metrics).
- The grid renders at y-offset MENU_BAR_H into term's own surface (the strip
  child covers [0, MENU_BAR_H) visually and takes the pointer events there;
  term fills the covered band with DEF_BG defensively). `apply_resize` maps
  `rows = (surf->h - MENU_BAR_H) / cell_h`.
- All main-window pointer math (selection cells, scrollbar) shifts by
  `y - MENU_BAR_H`; the 0273b scrollbar overlay spans the grid band
  [MENU_BAR_H, sh) instead of [0, sh).
- Parent RESIZED → `SDL_SetWindowSize(barWin, new_w, MENU_BAR_H)` (the A5
  owner-initiated child resize); the bar repaint rides the strip's own
  RESIZED ack (user32.c:1377 comment — same rule here).

### 4.2 The vtable instance (crib u32_mc_*, user32.c:1098-1170, minus HWNDs)

- `win_create` → `SDL_CreatePopupWindow(parent, dx, dy, w, h, grab ?
  SDL_WINDOW_POPUP_MENU : SDL_WINDOW_TOOLTIP)`, title `"#32768"` — the real
  Win32 menu-window class name, so `wmctl wait win "#32768"` works on term's
  menus exactly as on notepad's/gpubox's.
- `win_begin`/`win_present` → `__gdi_dc_wrap(s->pixels, s->w, s->h,
  s->pitch/4)` / unwrap + `SDL_UpdateWindowSurface` (byte-for-byte the u32
  ops; the DC default font is already the 20px system font).
- `screen_size` → `SDL_GetDisplayBounds`.
- `post_command` → direct dispatch switch on CM_* ids (no message queue;
  the engine calls AFTER the chain closed, so mutating term state is safe).
- `track_state(leaving)` → un-highlight + repaint the bar (g_barIdx analog).
- `popup_opening` → refresh live gray states (§4.4) before the level is
  measured — exactly what the hook exists for.

### 4.3 Bar front-end (crib menu_bar_pad/rect/at/draw/paint, user32.c:1300-1408)

Single top-level window, so the HWND parameter drops out; a `MenuTbl
*term_menu` global plus `bar_idx` open-title state. Paint via
`__gdi_dc_wrap` over the strip surface: COLOR_BTNFACE fill, bottom
COLOR_BTNSHADOW hairline, labels `TextOut` in the system font,
COLOR_HIGHLIGHT behind the open title — the user32 bar look, byte-identical
mechanism. Presented only on menu-state change (open/close/switch/resize),
never per term frame.

### 4.4 Menu tree (macOS Terminal as reference, scoped to actions that are
###     real TODAY)

- **Shell**: New Window (posix_spawnp `/bin/term`, own pgroup, reaped
  WNOHANG from frame_cb — the wm.c launch pattern); **Settings… — GRAYED
  stub**: the (d) settings-window lane's entry point, appended MF_GRAYED
  with a code comment naming (d); visibly present, deliberately inert,
  enabled by (d) when it lands (explicit deferral, not a silent cut);
  separator; Close Window (`exit(0)` — master close HUPs the session, the
  documented clean teardown).
- **Edit**: Copy (grayed unless `sel_on`), Paste (grayed unless
  `SDL_HasClipboardText()`), Select All (select the live screen:
  sel 0,0..cols-1,rows-1). All three reuse the existing 0090 handlers.
- **View**: Scroll to Top (`view_off = hist_count`), Scroll to Bottom
  (`snap_live`), separator, Clear Scrollback (`hist_clear`) — all over the
  0273a model; Top/Clear grayed when `hist_count == 0`, Bottom grayed when
  already live.
- **Deferred, explicitly**: a Window menu (Minimize/Zoom) needs WMP chrome
  ops term doesn't speak (it is not a wm.sock client) — recorded here, not
  silently cut; revisit if term ever grows a WMP client. Help likewise (term
  has no dialog furniture; an About box is (d)-adjacent). Accelerator
  *display* (⌘N etc.) waits for (d)/keys.h wiring — items carry no accel
  text they don't honour.

### 4.5 Event routing (crib user32's pump demux, user32.c:1409-1850)

- Events whose windowID is the strip child → bar mouse: press on a title
  opens (click on the open title closes; press elsewhere on the strip with a
  chain open closes); motion with a chain open hover-switches titles
  (Windows rule, `menu_bar_mouse` verbatim).
- Events on `__mc.lev[k].win` → `mc_level_mouse(k, …)` (SDL type →
  WM_MOUSEMOVE/LBUTTONDOWN/LBUTTONUP mapping).
- `CLOSE_REQUESTED` on a level window → `mc_close()` — the kernel grab's
  outside-press dismissal (press consumed by the kernel; menubox semantics).
- `KEY_DOWN` while `__mc.open` → `mc_route_key(sym)`, swallow-all (modal;
  an open menu never types into the pty and never snaps scrollback);
  printables fall through to `mc_typeahead` (the wm.c opt-in, one call).
- Term's loop keeps draining the pty and rendering under an open menu
  (levels are separate kernel surfaces — same as any user32 app animating
  under its menu). frame_cb's `__wait` fd set is unchanged: menu input
  arrives via the input ring, already a wait source.

### 4.6 Goldens / geometry-sensitive tests — deliberate rebaselines

The bar is ALWAYS-ON (macOS Terminal reference; an off-mode would be a
zombie fallback). No byte-identical legacy path — instead:

- `tests/kernel/test_term_e2e.js` (57 checks, 0273b count): every pixel probe
  and cell↔pixel mapping shifts +MENU_BAR_H in y; the window create size
  changes; scrollbar probes move to the grid band. Each moved constant gets
  rebaselined against the new layout with the shift stated in the dev log —
  no blind rebake (the 0273b lesson).
- `tests/browser/os-term.mjs` + any sweep leg reading term geometry
  (os-vt/os-shell reference term windows): same +30 y shift; enumerate at
  implementation time via the suite run, adjust each with a comment.
- NEW e2e session `menubar`: open a dropdown via wmctl pointer injection on
  the REAL strip-child surface, `wmctl wait win "#32768"` for the level,
  click an item (View → Scroll to Top against seeded history — observable
  via the 0273b thumb position), outside-press dismissal, Esc dismissal,
  hover-switch. 5/5 isolated + flake tripwire 3x per the lane gate.
- Image: term.c is a baked source → @master's merge bumps `image.json`
  version (lane does NOT touch it).

### 4.7 Diff surface estimate (path A)

`os/term/bin.json` +1 dep line; `os/term/term.c` +~350-400 lines (vtable ~60,
bar front-end ~150, menu build + commands ~80, demux ~80, geometry shifts
~30); tests. NO changes to kernel.js, the SDL veneer, menucore, user32, wm.c.

## 5. What @master decides

One word: **(A)** (menucore customer #3, +24 KB verified, engine-uniform,
links gdi32 via menucore.json — recommended) or **(B)** (no new linking,
term-private fontcore dropdown widget over the same kernel primitive,
accepting the widget-level fork). Everything else in §4 is shared or ready.
