# NetSurf JavaScript — Lane A: productionizing the duktape graft

Branch `netsurf-lane-a` off `netsurf-js-scope` (the scratch graft commit
97c1b304).  Design + audit: `todos/NETSURF-JS.md`; that doc's §8 is the
record of what the probe had wrong, and this log is the *why* behind the
choices the productionizing pass had to make.

## What was already decided going in

JS support ships with the **generated bindings committed** at
`vendor/netsurf/genjs/duktape/`, and no build ever regenerates them.  That is
not laziness about a build step: nsgenbind is flex+bison and needs GNU bison
≥ 3, Apple ships 2.3, and there is no package manager on this machine.  A
build-time dependency on nsgenbind would mean every checkout builds bison
from source before it can build a browser.  Committing 223 generated `.c`
buys: no bison anywhere in the normal path, and a *reviewable* diff whenever
a `.bnd` changes.

## Making "committed generated output" honest

Committed output rots silently unless regeneration is (a) reproducible and
(b) gated.  So `regen-js-bindings.sh` is a real pipeline, mirroring
`update.sh`'s shape: pin the generator in `UPSTREAM.json` (a new `tools`
section — nsgenbind @44c67369, buildsystem @0005ae30), fetch at the pin,
build, generate, install, and `--check` to diff instead of installing.

Getting byte-identity took two path discoveries, both of the same shape —
**nsgenbind bakes the paths you hand it, verbatim, into its output**:

- the outdir lands in every generated file's self-includes
  (`#include "duktape/binding.h"`), so it must be spelled `duktape`
  relative to a cwd of `genjs/` — an absolute outdir bakes absolute paths
  into committed source;
- the `.bnd` path lands in `#line` directives, so it must be spelled
  `../netsurf/content/handlers/javascript/duktape/netsurf.bnd`.

Generating into a temp dir therefore *cannot* reproduce the commit… unless
the temp dir has the same relative geometry.  The script stages exactly that:
a scratch `genjs/` next to a symlink named `netsurf` pointing at the real
tree.  Same relative strings, zero risk of a failed run leaving a
half-written `genjs/` in the working tree.  Verified: at the pins, all 223
`.c` + 3 headers + nsgenbind's `Makefile` come out byte-identical.

Two smaller things fell out of doing this properly:

- **The graft's `.inc` blobs were not what upstream's own tool emits.**
  `generics.js.inc`/`polyfill.js.inc` differed from `tools/xxd -i` output by
  one trailing comma.  Rather than special-case the diff, Lane A vendored
  `netsurf/tools/xxd.c` (added to `update.sh`'s prune whitelist — the libcss
  `gen_parser` precedent: a tiny host tool built with `cc` at vendor time)
  and installed the real tool's output.  `xxd -i` derives the array's C
  symbol from the input *path* and upstream's sed rewrites exactly one
  spelling of it, so that step runs from the netsurf root with upstream's
  relative path — and asserts the symbol exists afterwards, because a missed
  sed would otherwise produce an `.inc` declaring an array `dukky.c` never
  sees.
- **The 223-entry source list in `netsurf-core.json` is generated too.**
  nsgenbind emits a `Makefile` fragment whose `NSGENBIND_SOURCES` is its own
  manifest of what it wrote; `genjs-sources.mjs` splices exactly that list
  into the JSON (textually, preserving the other 380 lines byte-for-byte — a
  JSON round-trip would reformat the file and bury the real diff) and
  `--check` reports drift.  An interface added to a `.idl` can now never
  leave the build graph stale, and nobody hand-edits a 223-line JSON block.

The script also refuses to guess: it gates on `bison --version` up front with
build-it-from-source instructions (and states that nothing else in the repo
needs bison), and after generating it *classifies* every output file — `.c`,
`.h`, `Makefile` are source, nsgenbind's `-D` debug spill is pruned by name,
and anything else is a loud failure rather than a silent drop.

## The bug that had to be fixed to have an honest demo

Demo 2 is a counter: click a button, `input.value` goes up by one.  It went
up by **two**.

Root cause is in libdom, not in duktape or dukky.  `_dom_node_dispatch_event`
(`libdom/src/core/node.c:2525`) builds the propagation chain starting *at*
the target and walks it for both the capture and the bubble phase.
`_dom_event_target_dispatch` then fires non-capture listeners whenever
`phase == DOM_BUBBLING_PHASE` — with no exclusion for
`evt->current == evt->target`.  So a listener on the clicked node runs once
in the AT_TARGET phase and again as the bubble walk passes back over the
target.  Verified directly by logging `e.eventPhase`: the same handler
arrives with phase 2, then phase 3.  Ancestor bubbling was always correct
(one phase-3 delivery each), and `onclick=` attributes are hit identically,
since the bug is in delivery, not registration.

Fixed in `patches/libdom.diff` (the first libdom patch, so `libdom` joined
`update.sh`'s patch list): compute `at_target` once, and gate the capture and
bubble clauses on `!at_target`.  That is what DOM L3 says — listeners on the
target are invoked in the target phase, once each, whatever their capture
flag — and it also puts a capture-flag listener on the target in AT_TARGET
instead of the capture phase.

Deciding to fix it at all was the judgement call of this lane, since event
work is nominally Lane C.  It went in because this is not a missing feature,
it is a correctness defect in the code path being switched on for the first
time, the fix is one hunk in a vendored library with an established patch
mechanism, and the alternative was shipping a demo that visibly counts by
two.  Blast radius is small and checkable: only three places in the whole
tree register libdom listeners — dukky, libdom's own `classList` tokenlist,
and the canvas2d `DOMSubtreeModified` hook — and the latter two are
non-capture listeners on their own target, so they were *also* running twice
per event and are now correct.  The JS-off smoke stayed green.

`smoke-js.mjs` leg 2 asserts "one click = exactly ONE increment", so the fix
cannot regress quietly.

## Not fixed, deliberately

Two more real defects surfaced and were left for Lane C with a written
diagnosis (§8.3, §8.4), because fixing them is dispatch work with no bearing
on demos 1–3:

- **Capture listeners never fire**, and worse, they poison the element:
  `dukky_register_event_listener_for` keys its per-node registration map on
  the event *name* only, so a first `{capture:true}` registration leaves
  every later bubble listener for that type on that element silently dead.
- **A global whose name collides with a Window IDL attribute is silently
  swallowed** — `var frames = document.getElementById('frames')` leaves
  `frames` undefined, because `Window.frames` is a generated no-op stub with
  a no-op setter, and the script then dies at first use with the error only
  at NSLOG DEBUG.  This cost real debugging time in `sketch.html` (which is
  why that page uses `fpsBox`), and it is the §5 "silent no-op stub" class
  landing on the global object.  It is written up in `demos/README.md` as a
  page-author footgun.

## Gates: cheap first, and the probe was wrong about what monkey can do

The design doc claimed monkey has no pointer injection, so clicks had to be a
kernel e2e's job.  It does have it: `WINDOW CLICK WIN n X x Y y BUTTON LEFT
KIND SINGLE`.  That collapses the whole demo-2/3 story into the cheap,
deterministic, no-kernel monkey gate.

Two things made those clicks robust.  Coordinates come from the *plot
stream*: monkey prints `PLOT TEXT X x Y y STR Add one`, so the driver clicks
where the control's own label was rasterised — font-metric-derived, immune to
a font change, which a hardcoded pixel pair would not be.  And read-back
comes from the plot stream too: the counter's value is asserted as
`PLOT TEXT … STR 3`, which proves the *repaint*, not merely the DOM.  That
detour was forced anyway — monkey's `WINDOW EXEC` answers `RET TRUE` and does
nothing (`html_exec` appends a `<script>` node and returns whether the insert
worked; the insert-time execution never happens), a textbook silent symptom.

Every wait in the harness is on a marker — a console line, the
START/STOP_THROBBER pair, `REDRAW … STOP`, `INVALIDATE_AREA` — and a wait
that cannot be satisfied fails loud with the tail of the output.  The one
clock-watching leg is the watchdog leg, because bounding a 10 s watchdog is
the thing under test.

`--reuse` exists for iteration, and it *proves* freshness (wasm mtime vs
every linked input) rather than trusting it; the walk excludes `demos/`,
`test/`, the harnesses and the vendor scripts, which are not build inputs —
otherwise editing the harness costs a 60 s relink.

### What only the OS can prove

`tests/kernel/test_netsurf_js_e2e.js` covers the three things monkey cannot
speak for: `enable_javascript` defaults ON in the gucOS frontend (plain
`netsurf page.html`, no flag), the frontend's scheduler +
invalidate→damage→blit really repaints a `setInterval`+`putImageData` canvas
with **zero** input, and a real SDL click reaches a DOM listener.  Then it
writes `${HOME}/.netsurf/Choices` (the first entry on the frontend's resource
search path) and shows the same page painting nothing.

Its probes are colour *counts* over the content area, never fixed
coordinates: the canvas patterns are saturated and everything else on those
pages is white or black text, so "how many strongly-coloured pixels" is a
signal no font or layout change can shift.  Measured: 7601 coloured pixels
with JS on vs 0 with JS off; 12376 pixels changed between two frames with no
input; 0 green pixels before the click and exactly 20000 (= the whole 200×100
canvas) after.  ~5 s against a prebaked fixture.

Both rails were *verified*, not assumed: the watchdog cut `while(true){}` at
10.2 s with the browser still rendering and exiting cleanly, and the Choices
off-switch was checked in both harnesses.

## Cost

Measured back to back on one machine, swapping only `netsurf-core.json`:
`/usr/bin/netsurf` 3.04 MB → 5.36 MB (+2.32 MB), 30.3 s → 61.2 s build,
644 → 868 TUs; the monkey binary tracks it (2.65 → 4.97 MB, 27.2 → 56.9 s).
That matches the probe's estimate.  Accepted — it is what a JS engine plus
108 KLOC of generated bindings costs, and the design doc records it as the
deliberate trade.  Image bumped to v164.

## Out of scope, on purpose

Demo *seeding* (`/usr/share/netsurf-demos/` + Demos menu entries) is Lane E,
so `image.json` sees only its version bump — the kernel e2e plants its own
page rather than waiting on the seeds.  Demos 4–7 of the ladder each need
Lane B/C/D and are absent from `demos/` rather than faked.
