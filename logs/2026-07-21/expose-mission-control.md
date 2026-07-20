# Exposé / Mission Control — the window-overview mode (todos/EXPOSE-MISSION-CONTROL.md)

Landed the window overview / Exposé feature (Option B — small kernel mechanism +
wm.c policy, live seq-gated miniatures). Stacked on `meta-arrow` (Item 2's
Meta+arrow keymap, itself on keybind chunk 3). Branch `expose`.

## Why the design doc's opcodes shifted (0x35/0x92 → next-free)

The design doc (written before keybind chunk 3 landed) drafted the WMP opcodes
at `0x35`/`0x92` as "the next free slots". Chunk 3 then claimed `0x35`
(`WMP_GRAB_SET`) and `0x92` (`WMP_EV_HOTKEY`) first. Honouring the doc's stated
INTENT (next-free, not those literals), the overview ops take the actual
next-free slots:

- `WMP_OVERVIEW_SET = 0x36`, `WMP_OVERVIEW_END = 0x37`, `WMP_OVERVIEW = 0x38`
- `WMP_EV_OVERVIEW = 0x93`, `WMP_EV_OVERVIEW_PICK = 0x94`

## Why the chord became Ctrl+Alt+E (and NOT via a new wmKey block)

Chunk 3 had ALREADY scaffolded the overview trigger: a `KTOK_OVERVIEW` grab
token, a keys.h `wm.overview` registry action, `grab_table_push()` installing
it, and an `overview_toggle()` STUB dispatched from `hotkey_dispatch()` — but
bound to **F3**. The design doc's open-Q1 explicitly REJECTED F3 (a macOS
Mission-Control media key the host eats, plus browser-find) and jku baked
**Ctrl+Alt+E**. So the finalisation here is a one-line keys.h binding change
(F3 → Ctrl+Alt+E, both schemes, scheme-independent) + implementing the stub —
NOT a new hardcoded `wmKey` intercept, which would DUPLICATE the grab-table path
chunk 3 built. The doc's "Ctrl+Alt+E intercept in wmKey" is satisfied by the
existing grab-table row; the kernel-side EV_OVERVIEW is now ONLY the
`wmctl overview` command-side twin (the EV_MENU pattern), which wm.c also routes
to `overview_toggle()`.

## Mechanism / policy split

- **kernel** (`kernel.js` + `os/compositor.js`): `_wmOverview = null | {cells,
  hoverSid}`, a PURE presentation override — the kernel composites live
  miniatures at the WM's cell rects and routes hover/pick, and changes NO
  focus/z/minimize/geometry. `OVERVIEW_SET` validates sids (drops dead), stores,
  bumps; input branches in `wmKey`/`wmPointer` swallow everything (Esc/bg-down →
  `EV_OVERVIEW_PICK{0}`, cell-down → `PICK{sid}`, hover → `hoverSid`); last-
  subscriber-gone force-ends (the 0069 valve). Browser compositor gets an
  overview pass (shadow + rounded SDF chrome + the surface quad via
  shmBindFor/gpuBindFor UNCHANGED → gpu apps miniature LIVE, not black + caption
  + hover highlight + 0063-shape enter/exit fly). Headless `wmScreenshotScreen`
  gets the SAME branch (NN scale-blit + border fills, NO text/anims) so goldens
  stay bit-exact and `wmctl shot` sees the overview.
- **policy** (`os/wm.c`): candidate set = `wins[]` (furniture + foreign
  borderless never enter `wins[]`; minimized INCLUDED), LAUNCH order (stable
  across invocations). Grid aspect-fit layout (integer isqrt, no libm) computed
  in the tile() work area, cells letterboxed at scale ≤ 1. N=0 refuses; relayout
  on EV_SCREEN/CREATED/DESTROYED; PICK{0}→END, PICK{sid}→END+FOCUS+RESTACK (the
  taskbar-click codepath); popup/saver mutual exclusion. Three triggers:
  Ctrl+Alt+E (grab→EV_HOTKEY), `wmctl overview` (→EV_OVERVIEW), and a Task-View
  taskbar button right of Start (`TASKVIEW_W`).

## Gotcha: the Task-View button shifts the app-button strip

Placing the button right of Start (baked decision, Win10 position) moves the
app-button strip right by `TASKVIEW_W` (26px): button 0 goes from x≈86 to x≈112.
Five sweeps + one kernel e2e hardcoded taskbar-button coordinates and needed
updating: os-wm, os-aero, os-shell, os-ctxmenu, os-vt2zoom (browser) and
test_ctxmenu_e2e (menu anchor 86→112). Also keybind_registry_probe.c asserted
the F3 default (→ Ctrl+Alt+E).

## Gotcha: gpubox under the flake gate

os-overview's gpu-live leg uses gpubox. Under the flake gate's 4× CPU load,
gpubox's WebGPU first frame is legitimately slow (~125s, like os-gpubox), and it
renders its cube in a CENTERED viewport inside a gray win32 client — so the
robust probe is the client/miniature CENTRE (always cube/clear), never a corner
(gray margin) nor a fixed interior point (the cube spins). With that + generous
(satisfiable) timeouts, os-overview is flake-stable 3/3 under load; the winbox
live-flip leg (inject a key past the overview swallow → miniature follows) is the
CPU-robust "live miniature" proof.

## Deploy note

`wm.c` compiles into the OS wasm image, so the BUILT IMAGE CHANGED. `image.json`
was NOT bumped (left to jku via the coordinator). kernel.js / compositor.js /
os.html are static assets (not baked). A deploy = merge + bump image.json's
`version` + re-bake + ship the new blob AND the static assets.

## Gate

Full kernel suite green (test_overview_e2e + test_wm_policy overview legs +
keybind_registry/ctxmenu_e2e fixes; gucman_quake is the known cold-bake flake,
passes on retry). Browser sweeps green: os-overview (new, flake-stable),
os-keybind (macos + Ctrl+Alt+E), os-snap/os-wm (windows scheme unaffected),
os-aero/os-shell/os-ctxmenu/os-vt2zoom (taskbar shift), os-compositor (park logic
unaffected). Both new tests flake-stable 3/3 under load.
