# Menu build Spike 1 — anchored child surfaces + grab + focus funnel (todos/0256)

The first build milestone of the uniform-menu architecture (design: the
menu-uniform note in the external design thread, DECISION + amendments
A1/A2/A5/A8/A9/A10/A11). The kernel grows ONE policy-free, transport-blind
primitive — the anchored child surface — plus the grab and the owner focus
pair; the C surface is bone-stock SDL3; the proof is a fixture app with no
user32 and no menu code. The kernel still doesn't know what a menu is.

## What the kernel owns now

**Anchored children (§3.1, A1, A11).** SURFACE_CREATE flag bit 6 +
`parentSid`/`dx`/`dy` (parent must exist, same pid). `parentSid` forms an
arbitrary-depth TREE — every hook is a recursive subtree walk, not depth-1:

- geometry is MATERIALIZED (A11): `_wmAnchorApply` computes position (parent
  origin + offset scaled by the parent's dst/buffer ratio), inherited size
  scale, and the into-the-screen clamp (xdg-positioner "slide"), and STORES
  x/y/dstW/dstH on the surface at every mutation site — child create, wmMove
  / title drag / EV_SCREEN clamp (all funneled through
  `_wmMoveWithChildren`), wmSetDst, both configure paths. The scene walk,
  headless composite, hit test and browser compositor read a plain
  per-surface rect and stay anchor-blind: the design's "zero lines in the
  consumers" claim holds by construction. Because geometry re-derives from
  dx/dy each time, clamps never accumulate.
- raise-as-subtree: `_wmZNormalize` grew a post-pass that re-slots each
  child subtree immediately above its parent (creation-ordered, depth-first)
  after the layer sort, gated on a live anchored count so anchor-free scenes
  pay nothing. Since normalization already runs after every z mutation,
  children can never interleave with foreign windows in any rendering.
- hide/show with parent: `_wmAnchorHidden` walks ancestors (minimized ||
  !mapped) on the fly at the hit test / composite / cursor walk / wmScene —
  no state fan-out, and the walk only runs for surfaces that have a parent.
- destroy cascade: children die first, recursively; mid-tree destroys
  cascade their own subtree only; process-exit teardown is covered because
  `_wmDestroySurface` is idempotent per sid.
- children are chrome-free invariantly (SET_FLAGS can't grow them a title
  bar), never focused (create doesn't steal; clicks and wmFocus redirect to
  the anchor ROOT — clicking a background window's popup activates that
  window, matching Windows), and WM geometry/stacking/minimize ops refuse
  them with EPERM — wm.c policy never manages popups, and a lying success
  (the materializer would clobber the move) is worse than a loud refusal.
- owner-initiated child resize (A5): SURFACE_RESIZE works on children with
  the WM_MIN_SIZE floor relaxed to 1 — that floor exists to keep a framed
  window's title reachable, and menu-bar-class strips are legitimately
  20px tall. The configure ack re-derives the child's dst from the parent
  (never resets it to the buffer) and relayouts its own subtree.
- thumbnails (A10): `wmThumbnail` composites the mapped anchored subtree
  into the parent's buffer (materialized coords inverse-mapped, clipped to
  the parent rect) before box-filtering, so the M1 persistent bar will never
  leave a stale strip in Aero-Peek thumbs. The minimize fly-anim keeps
  drawing live surface quads (browser-only cosmetic; there is no snapshot
  mechanism to extend — children are hidden with the parent by then).

**The grab (A2).** `_wmGrabs` is a stack of holder sids, pushed at an
anchored create with flag bit 7 (SDL_WINDOW_POPUP_MENU), popped at destroy
OR at the dismissing press. While the newest holder lives: a press in the
client area of any surface in the holder's ROOT TREE routes normally (slide
between menu levels; in-window clicks are the in-process engine's own
dismissal turf, exactly as today); ANY other press — other windows, chrome
(own title included: Win95 eats the click that closes a menu), the desktop —
delivers WMEV.QUIT to the holder (the veneer's per-window
SDL_EVENT_WINDOW_CLOSE_REQUESTED, since a popup implies ≥2 live windows) and
is consumed, matching release included (`_wmGrabSwallowUp`). Two deliberate
hot-path decisions, both tested:

- the grab pops AT the dismissing press, not at the holder's destroy ack —
  a wedged owner can never turn one stuck popup into a system-wide input
  eater (one outside click = one dismissal, then routing is normal again).
- branch order: pointer lock > in-flight drags > grab > hit test. Locked
  routing never hit-tests, so quake's relmove is untouched (leg-tested);
  drags can't START under a grab (the press is consumed first), and a drag
  begun before the grab keeps its capture. Per-window INJECT_POINTER stays
  post-hit-test by design, so agents can still poke apps under a grab
  (user32's in-process route_mouse capture rides client events, which the
  grab routes normally inside the tree — the coexistence story).

Keyboard needs no grab: children never take focus, so keys already flow to
the popup's own process via the focused parent.

**The focus funnel (A9).** `_wmSetFocus` is now the ONE writer of
`_focusSid`; the three historical write sites (surface-create steal,
`_wmFocusFall`, wmFocus) all flow through it, so the owner pair
(WMEV.FOCUS_LOST → old owner, FOCUS_GAINED → new owner; SDL3 codes
0x20E/0x20F ride the ring verbatim) and the WM-subscriber EV_FOCUS fire at
EVERY transition by construction — half-wired focus events are worse than
none. One deliberate ordering choice: on create, the funnel runs AFTER the
EV_CREATED emit, because wm.c's menu-dismissal gating depends on the create
echo naming the sid before its EV_FOCUS arrives (wm.c:3284's comment is
explicit). Consequence: the EV_CREATED record now reports focused=0 and the
EV_FOCUS one message later carries the steal — wm.c's model converges within
the same drain (test_wm_policy pins the new contract).

## The veneer and the byte-identity lesson (the real story of this item)

First cut: decls + impls + two `__import`s straight into SDL.h/__SDL.c.
SameBoy interlock TRIPPED: +314 bytes. Root cause, fully decomposed: the
compiler emits every `__import` declared in a linked TU whether referenced
or not (precedent: `__clip_set` sits unused in SameBoy's import table
today), which also shifts every defined function index (+2 imports → LEB
widths in call sites and elem entries), and the dead functions' string
literals still landed in rodata. Not a miscompile — a linking-granularity
fact. The fix follows the item-0/webgpu precedent exactly: `SDL_popup.h` +
`__SDL_popup.c` are their OWN TU (`__require_source`), so the two imports
exist only in binaries that use popups. SDL.h keeps the (free) flag/event
defines and points at the sub-header.

Two byte-identity traps inside that restructure, both caught by hashing
SameBoy against HEAD after each step:

- de-static'ing `__sdl_window_register` (so the popup TU could call it)
  changed two elem-section bytes — the single-use inline-and-delete no
  longer fired for the now-external function. A tail wrapper forwarding to
  it was just as bad (second call site, same effect). The byte-neutral seam:
  de-static the registry ARRAY only (data symbol, no inlining interaction,
  declared in the new shared `__SDL_internal.h` along with the window
  struct) and let the popup TU slot windows in with its own 4-line loop.
  Registration matters because `__sdl_push_window_event`'s RESIZED
  re-derivation must cover popup windows — that IS the A5 path.
- and the perennial one: a backtick in a C comment inside the template
  literal (caught immediately by `node -e require`).

Final interlock: SameBoy 252938 bytes, sha256 `4ea46ff9…` — IDENTICAL pre/post.

## host.js

`__sdl_create_popup_window` (both flavors, same per-handle tables — presents,
events, destroy, owner-resize all ride the ordinary per-window paths;
deliberately does NOT repoint the browser flavor's legacy GPU sid),
`__sdl_get_display_bounds` (packed w<<16|h off the vDSO screen words — zero
RPCs, via a new `hooks.screen`), the FOCUS_GAINED/LOST drain cases (generic
`__sdl_push_window_event`), and the CD26 layout tripwire extended on BOTH
sides (kernel WM_SAB_LAYOUT.ev picks the new codes up automatically; host's
`mine.ev` grew them to match — the check forced it, as designed). Null and
standalone-browser backends stub both imports as clean failures.

## menubox + tests (red→green)

`tests/kernel/fixtures/menubox` (never baked — image stays v115): resizable
parent whose fill mirrors the focus pair, a persistent full-width TOOLTIP
strip child with app-rendered 5×7 "MB" glyphs (the headless-composite text
proof), a 't'-key TOOLTIP chain (popup + grandchild — draggable without
dismissal), a bar-click POPUP_MENU chain (the grab), a sibling top-level
whose title counts clicks (`mb-two-N`) so click-consumption is provable by
fencing on the NEXT allowed click's count — kernel titles are synchronous
where pixels are not.

- `test_wm_anchored.js` (kernel seam, no wasm): 52 FAILED against the
  pre-change kernel, PASS after — per-leg red for every mechanism above,
  including scale compounding through a 2-deep chain, the clamp
  re-derivation, grab/lock/injection coexistence, and thumbnail compositing.
- `test_menubox_e2e.js` (real veneer, wmctl-driven): drag-follow across the
  2-deep chain via a REAL title sdrag, minimize/restore hiding the subtree
  in `wmctl shot`, glyph pixels + popup OVERFLOW past the parent's bottom
  edge (the fidelity upgrade, §3.3.3), mid-tree kernel cascade, all three
  focus transitions observed through owner events, grab dismiss+consume,
  A5 strip-follows-width, cascade close with the sibling surviving. Dies
  loud against the pre-change kernel. Stable 3/3 under load ×10.
- One e2e-authoring gotcha worth recording: an "outside" click that lands on
  the grab-owning window's own client is INSIDE the grab tree by design —
  the first draft pressed at a point the dragged parent had moved under, and
  the dismissal (correctly) never fired. The press point must be clear of
  the whole owning tree.
- `test_waitevent_e2e`/`test_wait_e2e` park legs now consume (and pin) the
  create-time FOCUS_GAINED before parking; `test_wm.js`/`test_wm_policy.js`
  drains filter the pair (their legs assert INPUT routing; the pair has its
  own coverage).

## Deliberately not done here (scope boundaries)

user32 backend swap (M1), gpubox menu (M2), wm.c reseat (M4), wmctl's FLAGS
column showing the new ANCHORED bit (wm_proto.h exports WMP_F_ANCHORED; the
display change rides the next item that rebakes wmctl anyway — tests read
positions/behavior, not the flag char). The in-window dismissal gap (clicks
on the owning window's client don't dismiss) is the in-process engine's job
by design (§3.5) — user32 already does it today and keeps doing it in M1.
