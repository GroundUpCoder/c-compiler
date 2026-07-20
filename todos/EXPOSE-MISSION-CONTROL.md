# Exposé / Mission Control — the window-overview mode (design)

Status: DESIGN — no implementation yet. Companion queue item to be filed on
approval. Read together with `todos/WM.md` (compositor + WMP) and the
mechanism/policy precedents 0025 (maximize), 0032 (cycle chord), 0095 (Snap),
0096 (screensaver), 0063 (Aero anims/Peek).

The ask: a button and a keybinding that — instead of minimizing or tiling —
shows ALL open windows miniaturized and spread out non-overlapping so you can
visually pick one; clicking a miniature brings that window forward and exits
the overview. (macOS Exposé behavior. The request said "Launchpad", but
Launchpad is the app-launcher grid — the described behavior is Exposé /
Mission Control / Win10 Task View. This doc designs the window overview.)

---

## OPEN QUESTIONS FOR JKU (answers gate implementation)

1. **Trigger key: is `Ctrl+Alt+E` acceptable?** Recommended below. The
   "native" candidates are all host-collision landmines: **F3** is the
   macOS Mission Control media key (the host eats it) and browser-find;
   **Meta+Tab** is Cmd+Tab on macOS (uninterceptable OS app switcher) and
   Win+Tab on Windows (the host's OWN Task View); **Ctrl+Alt+Tab** is taken
   by our cycle chord (0032). `Ctrl+Alt+E` sits in the established wm-chord
   namespace with zero host collisions. **Coordination: a sibling design
   pass is currently deciding Meta+Left/Right (tiling vs line-nav). This
   design deliberately claims NO Meta+arrow chord** — Meta+Up/Down/Left/
   Right stay whatever Snap/that pass decides; the overview trigger is
   orthogonal by construction.
2. **Do minimized windows appear in the overview?** Win10 Task View: yes.
   macOS Mission Control: no (they live in the Dock). Recommendation: **yes**
   — their buffers stay live in gucOS (see §2), and "find the window I lost"
   is the feature's whole point. Cheap to flip either way.
3. **Button placement:** a Task-View-style button on the taskbar immediately
   right of the Start strip (recommended, Win10 position), vs a second
   far-right sliver next to Show Desktop (0101). Recommend next-to-Start:
   Show Desktop and Overview both being invisible slivers would be two
   unlabeled mystery zones.
4. **Enter/exit animation in v1?** The 0063 transient-anim machinery makes a
   200ms fly (real rect → cell rect, reverse on exit) straightforward and
   browser-only (headless composite shows the settled state, so goldens are
   unaffected). Recommend **yes in v1**, but it's cleanly severable if you
   want the static version sooner.
5. **Close-from-overview** (an ✕ badge on hovered miniatures, Mission
   Control style): recommend **defer** — v1 stays pick-or-dismiss. Flagged
   so it's a decision, not an omission.
6. **Architecture appetite:** Option B below (small kernel mechanism +
   wm.c policy, live miniatures) is the recommendation and touches
   kernel.js + compositor.js + wm.c + wm_proto.h. Option A (wm.c-only
   static-snapshot overlay, zero kernel change) exists as the cheap
   fallback but is explicitly demo-grade (static thumbs, gpu apps black).
   Confirm B.

---

## 1. What exists today (grounding)

- **The scene**: kernel.js owns per-surface records (`_surfaces`, z in
  `_zOrder`); `wmScene()` (kernel.js:5668) hands the browser compositor the
  z-ordered surface list plus `focusSid`, transient `anims`, glass flag.
- **The browser compositor** (os/compositor.js, one WebGPU pass per dirty
  rAF): every shm surface has a **cached per-surface GPUTexture** uploaded
  only when its frameSeq changes (`shmCache`, compositor.js:282–309); every
  gpu-transport surface has a cached texture refreshed per ImageBitmap
  (`gpuCache`, :314–336). The scene is redrawn from these caches each frame;
  a surface is drawn by pushing a textured quad at an arbitrary dst rect
  (`pushQuad`, :179; client draw at :578). **Drawing a window at 25% size at
  an arbitrary position is already a one-quad operation** — the minimize/
  restore fly animation does exactly this today (scaled full-surface quads
  along `animRect`, :380–385, :535–549).
- **The headless composite** (`wmScreenshotScreen`, kernel.js:5432) CPU-
  composites the scene deterministically and already has the nearest-
  neighbor scale-blit path for dst viewports (:5513–5527, the 0024 SET_DST
  machinery), plus `wmThumbnail` (:5579) has a deterministic box filter.
- **Chord seam**: `wmKey` (kernel.js:4688) intercepts WM chords ONLY with a
  WM subscribed and emits WMP events (EV_CYCLE :4698, EV_MENU :4705,
  EV_SNAP_KEY :4714, EV_SYSMENU :4723); each also has a command-side verb
  (`wmctl cycle/menu/snap/sysmenu`) firing the same event.
- **Policy side**: wm.c tracks all windows in `wins[]` (win_t, wm.c:292;
  MAX_WIN 64) with focus-recency stamps (0032) and knows its own furniture
  sids; it already owns work-area math (`fit_dst` wm.c:833, tile/cascade
  :860–885), a focus-restore pattern (`saver_prev`, :572, :1175–1206), and
  the Show Desktop stash (:337).

### The pivotal feasibility question, answered plainly

**Yes — the compositor already keeps a per-window pixel source for every
window, in both flavors, and scaling it down is free.** No snapshotting pass
is needed: in the browser the cached GPUTextures (shm) / imported bitmaps
(gpu) are sampled at whatever quad size we ask; headless, the shm front
buffers are readable in place and the NN/box-filter scalers already exist.
Miniatures are therefore **live by construction** — they keep animating while
the overview is up, at the cost of N quads per frame (the compositor's
normal cost, minus chrome). A static-snapshot design would be MORE work
(capture pass, staleness policy, memory) for a worse result — and
`wmThumbnail`'s CPU path reads only shm, so gpu-transport apps (gpubox)
would thumb black (kernel.js:5576), violating the GPU-apps-are-first-class
rule. Snapshots are rejected.

## 2. Architecture: mechanism/policy split (Option B — recommended)

Follows the house pattern (0025/0095): **the kernel renders and routes; wm.c
decides**. The kernel cannot invent layout policy (it has the no-WM fallback
rule), and wm.c cannot composite live pixels (only the kernel worker holds
the textures) — so the split is forced, and it lands exactly on the existing
seams.

### Kernel mechanism (kernel.js + compositor.js)

New scene state: `_wmOverview = null | { cells: [{sid, x, y, w, h}],
hoverSid }`, exposed via `wmScene().overview` and versioned through
`_bumpWm` (damage/park integration is free — every change re-arms the
compositor per the 0169 wake table).

New WMP surface (opcodes are the next free slots; wm_proto.h and kernel.js's
OP table must stay in lockstep as always):

- `WMP_OVERVIEW_SET = 0x35` `{ n, n × (sid, x, y, w, h) }` — enter overview
  (or relayout if already active) with the given cell rects. Kernel
  validates sids (dead ones dropped), stores, bumps. Only the WM subscriber
  may send it (R_ERR otherwise — it is a presentation takeover).
- `WMP_OVERVIEW_END = 0x36` `{ }` — leave overview, bump.
- `WMP_OVERVIEW = 0x37` `{ }` — command-side gesture (the ACTIVATE/CYCLE
  pattern): fires EV_OVERVIEW at the subscriber; R_ERR with no WM. Serves
  `wmctl overview` and the taskbar-button-less future.
- `WMP_EV_OVERVIEW = 0x92` `{ }` — the chord/gesture event ("toggle the
  overview"), emitted by the `Ctrl+Alt+E` intercept in `wmKey` (subscriber-
  gated, keyup swallowed — verbatim the EV_CYCLE rules, kernel.js:4693) and
  by OVERVIEW.
- `WMP_EV_OVERVIEW_PICK = 0x93` `{ sid }` — the user chose: a click landed
  in cell `sid`, or dismissed (`sid = 0`: background click or Esc).

Input routing while overview is active (a new early branch in
`wmPointer`/`wmKey`, the pointer-lock-branch precedent kernel.js:4813):

- pointer move → update `hoverSid` (cell containment test over
  `overview.cells`, topmost = last), bump on change;
- pointer down → EV_OVERVIEW_PICK { cell sid or 0 }; up swallowed;
- key Esc down → EV_OVERVIEW_PICK { 0 }; the trigger chord still toggles
  (reaches its intercept first); **all other input is swallowed** — apps
  never see half-gestures from overview mode. The kernel does NOT change
  focus, z, minimize, or any real geometry: overview is a pure presentation
  override; every state change is the WM's move after the PICK.
- Safety valve: last-subscriber-gone (`_wmSubs` empties) force-ends
  overview — a killed wm must never leave the screen stuck in a mode only
  the WM can exit (the 0069 map-everything-pending rule).

Rendering, browser (compositor.js): when `scene.overview` is set, the
surface loop is replaced by an overview pass — desktop clear, then per cell
(in cells order): drop-shadow + rounded-border quad (the existing SDF
chrome, mode 1/2), the surface's texture quad at the cell rect
(`shmBindFor`/`gpuBindFor` unchanged — live, seq-gated), a `labelFor(title)`
caption centered under the cell, and a highlight border on `hoverSid`.
Minimized surfaces render their (still-current) buffers like any other.
Enter/exit flys reuse the transient-anim shape (0063): on SET, per-cell
records {sid, from: real rect, to: cell rect, t0}; on END the reverse;
browser-visual only, pruned after WM_ANIM_MS.

Rendering, headless (`wmScreenshotScreen`): the same branch, using the
existing NN scale loop (kernel.js:5513) per cell + border fills; no text, no
hover-independent nondeterminism — captions are a browser affordance exactly
like title text (:5429). Goldens stay bit-exact and `wmctl shot` sees the
overview, which is what makes the e2e tests honest.

### WM policy (wm.c)

- **Candidate set**: `wins[]` minus this process's own furniture (bar,
  desktop layer, start/ctx/peek/saver/preview windows — wm.c already knows
  those sids) minus foreign borderless surfaces (popups/menus are not
  windows) minus unmapped; minimized included per open question 2. Order =
  `wins[]` order (launch order — matches taskbar button order, so the grid
  reads like the bar; NOT recency, which would shuffle cells every
  invocation).
- **N = 0**: refuse to enter (no-op — nothing to pick; the no-empty-state
  rule). **N = 1**: enter normally (consistent, and still a legible "where
  did it go" answer).
- **Layout** (grid, aspect-fit — see §3): computed in the work area (screen
  minus BAR_H minus the kernel title-bar margin, the tile() metrics
  wm.c:860); OVERVIEW_SET sent with the result.
- **Relayout events**: EV_SCREEN, EV_CREATED, EV_DESTROYED while active →
  recompute + re-SET (destroyed sid may vacate a cell; a new window joins).
  EV_OVERVIEW toggles; EV_OVERVIEW_PICK{0} → OVERVIEW_END;
  EV_OVERVIEW_PICK{sid} → OVERVIEW_END, then RESTORE if minimized, FOCUS,
  RESTACK to top — the taskbar-click codepath, reused.
- **Popup discipline**: entering the overview dismisses any open
  menu/peek/datepop (the saver_show precedent, wm.c:531); the screensaver
  and the overview are mutually exclusive (saver_show ends overview; idle
  can still fire while overview is up — overview input stamps
  `_wmLastInput`, so only a genuinely idle overview savers out, which is
  correct).
- **Trigger surfaces**: (a) taskbar button right of Start (START_W strip,
  wm.c:196) drawing a small three-pane glyph, click → toggle (straight to
  layout+SET — no self-round-trip needed); (b) `Ctrl+Alt+E` via
  EV_OVERVIEW; (c) `wmctl overview` for tests/scripts. Tooltip/doc string
  on the os.html Desktop tab title (os.html:177) alongside the cycle/menu
  chords — the discoverable-UI rule: button primary, chord documented
  alias.

### Option A, recorded and rejected

A wm.c-only overlay: fullscreen borderless top-layer window (screensaver
furniture, wm.c:1193) painting WMP_THUMB snapshots in a grid. Zero kernel
change, but: thumbnails are stale unless polled (Peek polls at frame-tick,
wm.c:548 — N windows × RPC × poll rate), THUMB caps at 512px and reads only
shm (gpu apps black, kernel.js:5576), payloads are full pixel frames over
the WM socket, and click-through/labels are all reimplemented in wm.c
raster. It is the demo-grade version of a capability the compositor already
has; per the build-to-the-goal rule, not proposed.

## 3. Layout algorithm

Grid with per-cell aspect-fit (Win10 Task View shape) — not macOS's
proportional packing. Rationale: packing preserves relative window sizes but
is an iterative optimizer with unstable output (small input deltas reshuffle
the field); a grid is deterministic, testable against goldens, O(N), and at
gucOS window counts (single digits, MAX_WIN 64 hard cap) the size-fidelity
loss is irrelevant. Concretely, for N candidates in work area W×H:

- `cols = ceil(sqrt(N * W / H))` clamped to [1, N]; `rows = ceil(N / cols)`
  (aspect-aware square-ish grid);
- cell = `(W - (cols+1)*GAP) / cols` × `(H - (rows+1)*GAP - CAPTION_H) /
  rows`, GAP 16, CAPTION_H reserved per row for the browser caption;
- each window aspect-fits its cell via the existing `fit_dst` math
  (wm.c:833) **with scale clamped ≤ 1** — small windows are never magnified
  (a 200px winbox at 3× would be a lie about its size); fixed-size windows
  and resizable windows are treated identically (it's a presentation rect,
  not a SET_DST — no interaction with the scaled/configurable exclusivity
  rule, 0024);
- last row centered horizontally (macOS reading-comfort detail, one
  subtraction);
- high N degrades gracefully: cells shrink, captions keep rows identifiable;
  no paging, no minimum-size floor in v1 (at 64 windows on 800×500 a cell is
  ~90×55 — cramped but functional, and far beyond real usage).

## 4. Interaction spec (v1, tight)

| Event | Result |
|---|---|
| Button / Ctrl+Alt+E / `wmctl overview` | toggle overview (no-op at N=0) |
| Click a miniature | that window: restore-if-minimized, focus, raise; exit |
| Click background / press Esc | exit, focus and z untouched |
| Hover a miniature | highlight border (browser; deterministic in composite too — hover follows injected pointer) |
| Trigger chord again while open | exit (toggle) |
| EV_SCREEN / window created / destroyed | relayout in place |
| wm killed while open | kernel force-ends overview (subscriber-gone valve) |

Not in v1 (flagged): close-from-overview ✕ badge (Q5), arrow-key cell
navigation + Enter (natural v1.1 — the kernel already swallows overview
keys, so it's additive), per-cell dimming of minimized windows, multi-
desktop/spaces anything.

## 5. Testing

- `tests/kernel/test_wm.js` mechanism legs: SET/END round-trip, sid
  validation, input swallowing, PICK emission (cell hit + background + Esc),
  subscriber-gone force-end, non-subscriber SET → R_ERR.
- `tests/kernel/test_wm_policy.js` / new `test_overview_e2e.js`: chord →
  grid appears (`wmctl shot` golden of the headless composite — the reason
  the CPU branch exists), pick focuses+raises, minimized window restored via
  pick, relayout on create/destroy, N=0 no-op.
- `tests/browser/os-overview.mjs`: VT2, real windows (winbox + term +
  gpubox — the gpu-transport leg matters here since headless can't see it),
  `wmctl overview`, pixel-assert miniatures + caption strip, click-through
  via INJECT_SCREEN, live-thumbnail assert (winbox fill flip visible while
  overview is up). Screen geometry from `__osScreen`, never constants.
- `tests/run.js` RULES already map wm.c/kernel.js/compositor.js →
  kernel+sweep; the new files register in the kernel run.js list (the
  0264 lesson: registration is explicit).

## 6. Cost/impact summary

kernel.js: ~1 state field, 3 ops + 2 events, 2 routing branches, a
composite branch (reusing the :5513 scaler), force-end valve. compositor.js:
one overview pass branch (reusing every existing helper). wm.c: candidate
set + grid math (~fit_dst-sized), event wiring, one taskbar button.
wmctl.c: one verb. wm_proto.h: the opcodes. Image version bump (wm.c is
baked). No app-facing API change, no SDL surface change, no host.js change,
no on-disk format change. The no-WM fallback is untouched (no subscriber ⇒
the chord passes through and OVERVIEW errors, per the EV_CYCLE rule).
