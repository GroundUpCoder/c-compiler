# 0273 child (d) — term Settings window + cfgstore persistence

Branch `gucos-0273d`, on top of v148's child (c) (menu bar riding the ONE
menu engine). This is the final 0273 child: the menu bar's grayed
"Settings…" item becomes a real settings window that edits term's config
live and persists it across relaunch.

## The window-rendering seam (the (b)-template decision)

Two candidate paths, mirroring the 0273b scrollbar call:

- **(B) a real user32 dialog** (EDIT/BUTTON controls, DialogBox/message
  loop). Rejected: term links `menucore.json` (menucore.c + gdi32.c +
  freetype) but NOT user32/kernel32 — deliberately, since 0273c. user32
  is not "a controls library": it owns the HWND tree, the classic
  blocking GetMessage loop, focus/capture routing, and the agent socket.
  Pulling it in for one options pane would put TWO event models in one
  process (term's SDL loop + user32's pump both draining the same SDL
  queue — they'd fight over every event), for five rows of furniture.
  That is the same "absurd for one widget" verdict (b) recorded for the
  SCROLLBAR control, one level up the stack.
- **(A) term draws its own settings window — CHOSEN**, with one
  refinement over (b): the scrollbar was pure grid-idiom pixel math, but
  since 0273c term ALREADY paints OS-uniform furniture (the bar strip)
  through `__gdi_dc_wrap` + gdi32 (FillRect/TextOut in the engine's
  font/colors). The settings window is that exact idiom on a second
  window: a fixed-size top-level SDL window (kernel chrome gives
  move/close for free; no SDL_WINDOW_RESIZABLE so it can't be sheared),
  painted BTNFACE with engine-font labels — pixel-uniform with every
  other OS menu/bar without a single new dependency. Events (clicks,
  Esc, close box) demux by windowID in term's existing loop, the same
  shape as menu_event.

So: reuse the RASTER (already linked), not the CONTROL TREE (not linked,
wrong process model). If a fourth non-win32 app ever needs the same
stepper/cycler furniture, factor a header then — the (b) rule.

## The window

"Term Settings", 300×192 client px, opened by Shell ▸ Settings… (now
ungrayed), closed by Esc / the title-bar close box / session end. Opening
it twice focuses the existing one (no duplicate windows). macOS Terminal
is the structural reference: changes apply IMMEDIATELY and persist
immediately — there is no OK/Cancel/Apply row (Terminal's Settings has
none either). Five rows, one per config axis, each `label [value] [◀|−]
[▶|+]`:

| row | axis | values | live apply |
|---|---|---|---|
| 0 | Font Size | 8..32 px, step 1 | re-size metrics, flush glyph caches, window re-sizes to the same 80×24 grid at the new cell (macOS keeps rows/cols, grows the window) |
| 1 | Theme | dark, light, green, amber, ocean | default fg/bg palette slots swap; value box previews fg-on-bg |
| 2 | Scrollback | 0..10000 lines, step 500 | ring re-allocates keeping the newest lines; view/scrollbar clamp |
| 3 | Cursor | block, under, bar | render style switches (block = the classic cell inversion, under/bar = fg overlay strips) |
| 4 | Bell | sound, visual, none | BEL handling switches |

Numeric steppers + enum cyclers rather than free text entry: every axis
is either bounded-numeric or a closed enum, so a hand-rolled EDIT caret
would add furniture no axis needs (and macOS Terminal itself uses
steppers/popups for four of the five). Keyboard interaction is Esc-only
by scope note (pointer-driven pane, like the reference); the menu
engine's modal keyboard is untouched.

## Persistence — the ONE cfgstore facility (CS3)

Store name `term`: `~/.config/term` > `/etc/term` > baked
`/usr/share/term` (new in image.json), overlaid PER KEY via cfgstore.h —
no wrapper header factored (saver.h/sounds.h earned theirs by having two
consumers; term's store has one, the cfg_* calls are used directly — the
(b) rule again). Keys, matching the baked defaults exactly so a
factory image and a storeless run agree:

    fontsize   14        (8..32, px)
    theme      dark      (dark | light | green | amber | ocean)
    scrollback 2000      (lines, 0..10000)
    cursor     block     (block | under | bar)
    bell       sound     (sound | visual | none)

Every settings-window change delta-writes exactly its one key to the
user layer (cfg_set) — a future image's new baked default reaches
existing users for keys they never touched. Startup loads the overlay
BEFORE glyph metrics / ring allocation, so a relaunch comes up in the
persisted config (the acceptance round-trip).

## Live reload across processes (FS_WATCH customer #3)

macOS Terminal applies profile edits to every open window, and gucOS
grew FS_WATCH (#75/0264) for exactly this shape — so term arms a watch
on `~/.config` (dir watch: survives the file not existing yet; cfg_set's
tmp+rename lands as a same-dir RENAME record naming `term`) and folds
the watch fd into its unified WAIT ({master ⊕ watch ⊕ ring} — the
mgp/fileman precedent). Any settled event naming `term` (or an
OVERFLOW) reloads the overlay and applies it through the same
idempotent apply paths the settings window uses; a term whose settings
another term edits follows live. Watch-open failure is a loud stderr
warning, not a tier: settings still work in-process, only cross-process
sync is lost (and under a kernel — which term hard-requires for the pty
— the primitive always exists).

## Behaviour details

- **Font size**: metrics recompute (FT_Set_Pixel_Sizes + hinted 'M'
  advance, the load_glyphs math factored into set_metrics), both glyph
  cache tiers flush and ASCII re-renders eagerly, the fallback chain
  probes at the new px, and SDL_SetWindowSize renegotiates the surface
  (0019 path — the existing RESIZED handler re-derives everything; cols
  ×rows are unchanged by construction). History lines store CELLS, not
  pixels, so scrollback re-renders at the new size for free.
- **Theme**: PAL loses its const; slots 16/17 (default fg/bg) are the
  only mutable entries — the 16 ANSI colors stay fixed (a theme is the
  default pair, not a palette rewrite; SGR-colored output keeps its
  colors on any theme, like Terminal profiles).
- **Scrollback ring** goes from a static `hist[SCROLLBACK_MAX]` array to
  a heap ring sized by config; re-sizing keeps the NEWEST min(count, n)
  lines. 0 = scrollback off (hist_push gated; the bar hides itself since
  hist_count stays 0).
- **Cursor**: block keeps the existing cell_colors inversion
  byte-identical; under/bar skip the inversion and draw a 2px default-fg
  strip (bottom / left of the cell) after the glyph pass — live view
  only, like the block.
- **Bell**: BEL (0x07) was silently ignored. Now: `sound` fires the
  0094 sound scheme's new `Bell` event (ding.wav; pumpless/headless
  kernels drop it silently, muted schemes honor `mute on`), `visual`
  inverts the grid band for ~120ms (one one-shot __wait timeout — no
  idle wakes; the 0273b no-timers rule bends only while a flash is
  literally on screen), `none` restores the old silence. BELs coalesce
  per drain pass (a `yes $'\a'` flood plays once per frame, not per
  byte).

## Deferred (explicitly, not silently cut)

- **Font FAMILY choice**: the store carries no `font` key; term's face
  is the system mono pair (/etc/fonts/mono.ttf > baked) with the
  fontchain fallbacks — a family picker needs a font enumeration
  facility no OS surface has yet (fileman/ctlpanel have none either).
  The axis joins the fontpkg backlog, not this store, when one exists.
- **Full keyboard nav in the pane** (arrows moving a focus ring):
  pointer + Esc matches the reference's pane; revisit with a keys.h
  action if a keyboard-only user story lands.
- **Per-window profiles** (macOS's multiple-profiles model): ONE store,
  the CS3 shape; profiles would need a store-namespace concept across
  ctlpanel/openwith too — an OS-wide design, not a term lane.

## Test plan

`test_term_e2e.js` session `settings` (REAL path end-to-end): menu
keyboard walk (Down Down Enter — metrics-independent) fires the ungrayed
Settings… → `wait win "Term Settings"` → a second term launches (still
baked-dark, 640×486) → theme ▶ click flips BOTH terms (the second via
the FS_WATCH reload — shot-asserted light band) → fontsize + click
changes term 1's window dims off 640×486 → scrollback − / cursor ▶ /
bell ▶ clicks → `cat ~/.config/term` shows exactly the five delta keys →
pkill, relaunch → the fresh term's dims EQUAL the live-applied dims and
its band is light (the persistence round-trip) → Esc closes a reopened
settings window. Defaults are untouched, so every existing session
(term/frames/nested/less/unicode/wide/scrollback/scrollbar/menubar)
stays byte-identical by construction.

No dedicated browser-sweep settings leg (the (b) rule): the kernel
session drives the full real path bit-exact (clicks, watch reload,
persistence, shots), and the browser-specific surface — compositing a
second plain top-level window — is covered by every multi-window sweep
already; os-term.mjs's existing 15 legs (incl. the 0273c menu ones) stay
green unchanged.

## The one fix the gate forced

Live font-size apply initially left the kernel geometry at 640×486: the
0019 renegotiation acks SURFACE_CONFIGURE on the app's first present AT
the new size, but a same-grid resize (80×24 before and after) hit
apply_resize's early return without setting `dirty` — term never
presented, the ack never fired. frame_cb's RESIZED branch now sets
`dirty = 1` unconditionally (the re-derived surface is stale anyway);
the relaunch leg (which came up 720×510 correctly all along) pinned the
diagnosis.
