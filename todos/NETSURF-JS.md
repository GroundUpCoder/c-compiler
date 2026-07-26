# NetSurf v2 — JavaScript support (duktape) — design & scoping

Status: **LANE A LANDED (2026-07-25); LANE B LANDED (2026-07-26)**; lanes
C–E open.  Everything below is evidence from a live probe, with each lane's
findings folded in (§8 = where the probe's expectations turned out wrong,
§9 = the same for Lane B).

**§5's "THE KILLER GAP — DOM mutation is invisible" is no longer true**:
Lane B's re-conversion bridge landed.  The paragraphs describing it are kept
as written because they still document the upstream starting point, but read
them past §9.

Lane A shipped: vendored `duktape/`+`WebIDL/`, the committed nsgenbind output
at `genjs/duktape/`, `regen-js-bindings.sh` + `genjs-sources.mjs`, the
`netsurf-core.json` swap, `enable_javascript` defaulting ON in the gucOS
frontend, one libdom event-dispatch fix, the `demos/` 1–3 pages, the
`smoke-js.mjs` gate (5 legs) and `tests/kernel/test_netsurf_js_e2e.js`.
See `vendor/netsurf/README.md` and `vendor/netsurf/demos/README.md`.

## Verdict

**FEASIBLE-WITH-CAVEATS.**  Every candidate hard blocker was probed and none
blocks:

- compiler.js compiles duktape 2.7.0 (the 101 KLOC amalgamation) **unmodified,
  zero patches**, and the result RUNS correctly — including JS `try/catch`,
  which exercises the setjmp/longjmp error path end to end.
- The full grafted browser (netsurf-core + dukky + 223 nsgenbind TUs +
  duktape) builds and **executes real `<script>` content in-browser**:
  console.log, DOM mutation, `body onload`, and `setTimeout` over the
  NetSurf scheduler all verified via the monkey harness.
- The gucOS frontend is NOT a one-shot plot: content-driven invalidation →
  dirty-rect → repaint works without user input, driven from the
  scheduler-deadline main loop.

The single most-likely-to-kill-the-*ambition* risk is **not in our port at
all — it is upstream NetSurf's own JS maturity**: arbitrary DOM mutation
never triggers re-box/re-layout/repaint (mutated DOM stays invisible), only
`click`/`keydown`/window-`load` UI events are ever fired at JS, canvas 2D has
no drawing primitives (ImageData get/put only), and many bindings that exist
in WebIDL are generated no-op stubs (`document.title` setter is an empty
function).  "JS runs" is a small lane; "interactive demo apps" requires three
additional upstream-shaped lanes (mutation→reflow bridge, event coverage,
binding fills) detailed below.  All are tractable; none needs compiler or
kernel work.

## Measured numbers

Lane A re-measured both configurations on one machine, back to back (swapping
only `netsurf-core.json`), for both link targets.  The probe's numbers held.

| metric | JS off | JS on | delta |
|---|---|---|---|
| `nsmonkey.wasm` (bin.json) | 2,782,623 B (2.65 MB) | 5,210,211 B (4.97 MB) | **+2,427,588 B (+2.32 MB)** |
| `nsmonkey` build (buildProject) | 27.2 s | 56.9 s | **+29.7 s** |
| `nsmonkey` TUs (dep closure) | 622 | 846 | **+224** |
| `/usr/bin/netsurf` (gucos/bin.json) | 3,183,445 B (3.04 MB) | 5,616,394 B (5.36 MB) | **+2,432,949 B (+2.32 MB)** |
| `netsurf` build | 30.3 s | 61.2 s | **+30.9 s** |
| `netsurf` TUs | 644 | 868 | **+224** |
| duktape.c alone | — | compiles in ~1 s, links standalone at 702 KB | — |

+224, not the probe's +225: two files in (`dukky.c`, `duktape.c`) plus 223
generated, one out (`javascript/none/none.c`).  The TU totals are higher than
the probe's ~592/~817 because this count includes the whole dep closure
(zlib/libpng).  nsgenbind output: 227 files (223 `.c`), ~108 KLOC.

## Evidence per question

### 1. setjmp/longjmp — NOT a blocker (was ranked #1 risk)

compiler.js has a dedicated setjmp/longjmp lowering (`compiler.js:13906`
"setjmp/longjmp lowering"): setjmp-in-if-condition patterns rewrite to a
try/catch region; `longjmp(buf, v)` becomes `__throw __LongJump(...)`.
Production proof already existed in-tree: lua 5.5 (`LUAI_THROW`) and
micropython (`nlr_push` — the comma-expression form is explicitly handled,
`compiler.js:13914`).

Duktape fits the supported pattern exactly: **two** setjmp sites in the whole
amalgamation, both `if (DUK_SETJMP(jb) == 0) {` (`duktape.c:68801`,
`duktape.c:80153`).  On our target `duk_config.h` resolves `DUK_SETJMP` to
plain `setjmp` (`duk_config.h:2151` — the Apple `_setjmp` branch is not taken
for wasm).  Runtime proof: a thrown-and-caught `TypeError` (`null.x` inside
`try`) behaves correctly in the compiled wasm.

### 2. compiler.js compiles duktape — YES, unmodified

`node compiler.js -a compile duktape.c -I<netsurf> -I<netsurf>/include` →
**zero compile errors** (~1 s).  The only find was link-time: `duk_custom.h:37`
declares `dukky_check_timeout` (lives in dukky.c) — an expected external, not
a bug.  Full standalone link (duktape + test main): 702 KB wasm.  Runtime
smoke covers fib recursion, Array.sort, try/catch, JSON round-trip, regexp
replace, a 1e5-iteration loop, `Date.now()` (sane epoch), and 5000-deep JS
recursion — all correct output, no traps.  `NETSURF_USE_DUKTAPE` needs
`-DDUK_OPT_HAVE_CUSTOM_H` (upstream `duktape/Makefile:58`) — included in the
probe build.

### 3. Dynamic repaint — WORKS (was the sleeper risk; it isn't)

The gucOS frontend (Lane 2) has the full path:

- `gui_window_table.invalidate = gucos_window_invalidate_area`
  (`vendor/netsurf/gucos/gui.c:554-569`, impl `gui.c:376`) → per-window
  dirty-box union (`gucos_damage`, `gui.c:106`).
- `gucos_redraw_all()` runs **every main-loop pass** (`gucos_run`,
  `vendor/netsurf/gucos/main.c:227-250`) and plots accumulated damage via
  `browser_window_redraw` (`gui.c:242-260`), then blits + presents.
- Core chain verified: `content_request_redraw` → `CONTENT_MSG_REDRAW`
  (`content/content.c:450`) → `browser_window_invalidate_rect`
  (`desktop/browser_window.c:1562`, `:4043`) → frontend `invalidate`.
- Drag-resize reflow and content-driven redraw converge on the same
  machinery; `browser_window_schedule_reformat` posts through
  `misc->schedule(0, …)` which the loop services.

So anything JS triggers **through the scheduler or an input event** paints
promptly with no user input.  What does NOT exist is the *content-side*
"DOM changed ⇒ request re-layout" trigger — that is question 5/Lane B, an
upstream gap, not a frontend gap.

### 4. Event loop + timers — WORKS

`gucos_run` (`main.c:227`) = fire due scheduler callbacks → drain SDL input →
redraw → park in `SDL_WaitEventTimeout(NULL, next_deadline_ms)` (the kernel's
unified WAIT; −1 = sleep-until-input when nothing scheduled).  The scheduler
is the fb frontend's list (`gucos/schedule.c:96-194`) and returns
ms-to-next-deadline.  JS `setTimeout` is already implemented upstream over
exactly this seam (`Window.bnd:516`, → `guit->misc->schedule`,
`Window.bnd:183`), with self-rescheduling `setInterval` (`Window.bnd:117`)
and a 10 ms minimum clamp (`Window.bnd:529`).  Full-stack proof: a
`setTimeout(fn, 300)` fired on time in the monkey run with zero input.
`requestAnimationFrame` is NOT implemented upstream (idl-only) — see Lane D.

### 5. Upstream JS/DOM binding surface — the real gap (audited exhaustively)

Architecture note: WebIDL files define interface *shape*; `.bnd` files supply
C bodies; **anything in the .idl without a .bnd body generates a silent no-op
stub** (e.g. `document.title` getter AND setter are empty functions —
verified in generated `document.c:1897-1925`, and confirmed live: the title
never changes).  "Exists in IDL" ≠ works.

WORKS today (with .bnd bodies, verified):
- Engine + heap + 10 s exec-timeout watchdog (`dukky.c:840`, reset at every
  entry, `JS_EXEC_TIMEOUT_MS`).
- `addEventListener`/`removeEventListener`/`dispatchEvent` with real
  capture/bubble/once semantics (`EventTarget.bnd:141+`, driver
  `dukky.c:1143-1344`); `on*` attribute handlers via on-prefix scan
  (`dukky.c:1519`).
- UI events actually FIRED by the browser: **`click`**
  (`html/interaction.c:1404`, real libdom dispatch w/ bubbling) and
  **`keydown`** (`interaction.c:1567`) and **window `load`** (js_fire_event
  is deliberately crippled to load-only — `dukky.c:1581-1585`, admitted
  "get 3.4 out" stopgap).
- DOM mutation calls: createElement/appendChild/insertBefore/removeChild/
  setAttribute/textContent-set/classList (Node.bnd, Element.bnd);
  `innerHTML` SETTER (real hubbub fragment parse, `Element.bnd:432`) — but
  getter returns `""` (`Element.bnd:426`).
- Traversal: getElementById, getElementsByTagName, child/sibling getters.
  NO querySelector/querySelectorAll/getElementsByClassName (idl-only).
- Forms: input `value`/`checked` get/set — and these DO repaint
  (`dom_event.c:738` → `html_texty_element_update` → gadget sync + box
  redraw).  But `change`/`input`/`submit` events are never fired.
- Canvas: getContext("2d"), width/height, createImageData/getImageData/
  **putImageData** — and putImageData DOES repaint
  (`CanvasRenderingContext2D.bnd:597` → bitmap modified + `redraw_node`).
  NO fillRect/paths/arc/text/drawImage/fillStyle — no drawing primitives at
  all; a canvas app must rasterize into a JS pixel array.
- `document.write` during parse (`Document.bnd:26` → live hubbub chunk
  insert); console.* (verified live); setTimeout/setInterval (verified live).
- polyfill.js/generics.js: Array.from, list proxies, console formatting —
  no Promise, no fetch, no storage.

THE KILLER GAP — DOM mutation is invisible: the html handler's libdom
default-action hooks (`html/dom_event.c:765`) special-case only
BASE/IMG/LINK/META/STYLE/SCRIPT/TITLE on insert and STYLE/TITLE/INPUT/
TEXTAREA on modify.  A plain `<div>`/`<span>`/text insertion triggers
**nothing** — no box construction, no reflow, no repaint.  And
`html_reformat` (`html/html.c:1053`) only re-runs `layout_document` over the
EXISTING box tree; box construction (`dom_to_box`, `html.c:404`) runs once at
conversion.  Verified live: `input.value` mutation from script visibly
sticks, but structural DOM edits would not repaint.  Todo lists, tab
switchers, "write into a span" counters are dead on arrival without Lane B.

### 6. What demo class is possible (and the acceptance ladder)

With Lane A alone (vendor + enable): event-driven JS with output through
channels that already repaint — form fields and canvas pixels.
With B+C+D: normal DOM-driven interactive apps.

Acceptance demo pages (seed at `/usr/share/netsurf-demos/` + Demos menu,
easiest → hardest; each names the lanes it gates on):

1. `hello-js.html` — inline script + console.log + computed text via
   `document.write` at parse time.  [A]
2. `counter.html` — `<button onclick>` increments and writes
   `input.value`.  Proves click dispatch + visible update.  [A]
3. `sketch.html` — canvas; click paints via getImageData/putImageData;
   setInterval animation ticker.  [A]
4. `stopwatch.html` — setInterval writes into a `<span>` via textContent.
   **First page that REQUIRES the mutation→reflow bridge.**  [A+B]
5. `todo.html` — text input + Enter/keydown + createElement/appendChild list
   + click-to-delete.  [A+B, better with C's `change`]
6. `paint.html` — mousedown/mousemove/mouseup freehand canvas drawing with
   fillRect brush + color swatches.  [A+B+C+D-canvas]
7. `breakout.html` — canvas game: rAF (or 16 ms setInterval), keydown/keyup
   paddle, fillRect/arc rendering, score in DOM.  [A+B+C+D]

### 7. Test / gate strategy

Follow the established NetSurf harness stack, cheapest first:

- **Vendored smoke leg** (`vendor/netsurf/smoke.mjs` or a sibling
  `smoke-js.mjs`): build once, drive monkey protocol over stdio, assert on
  `WINDOW CONSOLE_LOG` lines — deterministic, no kernel, no browser.  The
  probe's driver already does this (script-exec + timer + mutation asserts
  via console.log sentinels).  This is the Lane A gate.
- **Kernel e2e** `tests/kernel/test_netsurf_js_e2e.js` (pattern:
  `test_netsurf_layout_e2e.js`): boot OS, spawn netsurf on a demo page,
  drive via `wmctl` (INJECT_POINTER on the netsurf window at known layout
  coords; keydown via inject), assert via `wmctl shot` pixel probes (the
  counter digit region, the canvas painted region) — plus console-sentinel
  file writes if pixel probes get brittle (a demo page can also signal via
  `input.value` + AQ-less pixel row).  Register in `tests/kernel/run.js`'s
  explicit registry and the `tests/run.js` RULES row for
  `vendor/netsurf/**`.
- **Browser sweep leg** `tests/browser/os-netsurf-js.mjs` (pattern:
  `os-present.mjs`): one interactive demo driven end-to-end on VT2.
- Flake gate: `node tests/flake.js` after landing any new e2e (repo rule).
  No fixed sleeps — wait on console sentinels / pixel deltas.

## 8. What Lane A found that this document had wrong

Recorded so B–D plan against reality, not against the probe's guesses.

1. **monkey CAN inject pointer clicks.**  §7 and the Lane A sketch both say
   "monkey has no pointer injection — so counter clicks are the kernel e2e's
   job".  Wrong: `WINDOW CLICK WIN n X x Y y BUTTON LEFT|RIGHT KIND SINGLE|
   DOUBLE|TRIPLE` (`frontends/monkey/browser.c:665`) drives
   `browser_window_mouse_click` directly.  So the whole demo-2/3 click story
   is drivable in the cheap monkey gate, and `smoke-js.mjs` does it —
   clicking by the coordinate the control's own label was PLOTTED at, which
   is font-metric-derived and survives a font change.  The kernel e2e is
   still worth having, but for what only it can prove (the frontend's option
   default, scheduler and SDL input map), not for clicks per se.
2. **A non-capture listener on the click TARGET fired twice per click** —
   a plain counter counted 2.  Root cause in libdom, not dukky:
   `_dom_node_dispatch_event` (`libdom/src/core/node.c:2525`) builds the
   propagation chain starting AT the target, and
   `_dom_event_target_dispatch` (`libdom/src/events/event_target.c:230`)
   fired non-capture listeners for `phase == DOM_BUBBLING_PHASE` without
   excluding `evt->current == evt->target` — so at-target ran, then the
   bubble walk passed back over the target and ran it again.  FIXED in Lane
   A (`patches/libdom.diff`, one hunk, upstreamable); it also halves the
   duplicated work in libdom's own `classList` tokenlist handler and the
   canvas2d `DOMSubtreeModified` handler.  Ancestor bubbling was and is
   correct.  Guarded by `smoke-js.mjs` leg 2.
3. **Capture-phase listeners never fire at all, and poison the element.**
   `addEventListener(t, f, true)` / `{capture: true}` produces no
   invocation in any phase; and because
   `dukky_register_event_listener_for` (`dukky.c:1344`) keys its per-node
   registration map on the event NAME only, the first capture registration
   makes every LATER non-capture listener for that type on that element
   silently dead too (registering capture-then-bubble on one element =
   total silence).  NOT fixed — Lane C, with the rest of the dispatch work.
   Diagnosed only as far as "the libdom listener is registered with
   capture=true and the dukky handler is not reached"; finish the trace
   there.
4. **A global colliding with a Window IDL attribute is silently swallowed.**
   `var frames = document.getElementById('frames')` leaves `frames`
   undefined (`Window.frames` is a generated no-op stub with a no-op
   setter), and the script dies at the first use with the error only at
   NSLOG DEBUG.  This is §5's "silent no-op stub" class landing on the
   GLOBAL object, which makes it a page-author footgun rather than a
   missing feature; it cost real debugging time while writing
   `sketch.html`.  Lane D should consider making unimplemented Window
   attributes throw rather than read undefined.
5. **Click events are plain `Event`s, so they carry no coordinates**
   (`clientX`/`pageX` are `undefined`, `e.constructor.name === 'Object'`).
   §5/Lane C imply this, but it is worth stating as a hard consequence:
   demo 6 (`paint.html`) needs Lane C's `fire_dom_mouse_event` before a
   draw-where-you-clicked canvas is possible at all, not merely nicer.
6. **monkey's `WINDOW EXEC` is unusable as a probe: it reports success and
   does nothing.**  It answers `WINDOW JS WIN n RET TRUE` while the injected
   script has no effect (verified: an `input.value` assignment through EXEC
   never lands).  `html_exec` (`html/html.c:2089`) appends a `<script>` node
   carrying the source to the body and returns whether the *insert*
   succeeded — the insert-time execution never happens.  That also says
   something for Lane B: appending a script element from JS does not run it.
   `smoke-js.mjs` therefore asserts through real clicks + the plot stream
   instead, which is stronger anyway.
7. **The two rails hold with JS on, verified rather than assumed.**  The
   10 s watchdog aborts `while(true){}` (measured 10.2 s) and the browser
   still renders and exits cleanly afterwards; `enable_javascript:0` in
   `Choices` yields zero script output with the page still rendering —
   both as `smoke-js.mjs` legs 4/5, and the Choices rail again in-OS at
   `${HOME}/.netsurf/Choices` in the kernel e2e.
8. Regeneration of the bindings is byte-identical at the pinned nsgenbind
   revision — but only if the outdir is spelled `duktape` and the `.bnd`
   path `../netsurf/…`, because nsgenbind bakes both verbatim into
   self-includes and `#line`s.  `regen-js-bindings.sh` stages that geometry;
   `--check` is the drift gate.  The graft's `.inc` files were NOT what
   upstream's own `tools/xxd` emits (one trailing comma); Lane A switched
   them to the real tool's output and vendored `tools/xxd.c` for it.

## Lane breakdown

Lane A is proven by the probe; B–D are upstream-shaped NetSurf work (ours to
write, since upstream hasn't); E is gucOS integration.  B, C, D are
parallelizable in separate worktrees after A (disjoint files: B =
html handler, C = interaction.c + dukky.c, D = .bnd files); E's scaffold can
start with A.

**Lane A — vendor duktape + committed bindings + build integration (S-M).**
**DONE 2026-07-25** — as planned below except where §8 says otherwise.
- `update.sh`/`UPSTREAM.json`: stop excluding
  `content/handlers/javascript/duktape/` + `WebIDL/`.
- Commit nsgenbind output at `vendor/netsurf/genjs/duktape/` (223 .c + hdrs,
  ~108 KLOC generated; MIT, generator makes no copyright claim).  Generated
  self-includes are RELATIVE when nsgenbind gets a relative outdir (run from
  `vendor/netsurf/genjs`, outdir `duktape`) — no path rewriting needed.
  Commit a `regen-js-bindings.sh` + README note: regeneration needs host
  flex + **bison ≥ 3** (Apple ships 2.3 — probe built GNU bison 3.8.2 from
  source; normal builds never need it, only regeneration after .bnd/.idl
  edits).
- Commit xxd'd `generics.js.inc`/`polyfill.js.inc` (or generate at bake —
  they're tiny; committing matches the "no build step" rule).
- `netsurf-core.json`: swap `javascript/none/none.c` → `duktape/dukky.c` +
  `duktape/duktape.c` + the genjs list; includes += `genjs`; compilerArgs +=
  `-DDUK_OPT_HAVE_CUSTOM_H`.
- Flip `enable_javascript` default true in gucOS `set_defaults`
  (`vendor/netsurf/gucos/main.c:195`) — JS-on is the goal; the 10 s exec
  watchdog bounds runaway scripts.  (`Choices` file at
  `/usr/share/netsurf/` remains the admin off-switch; frontend already
  reads it, `main.c:344`.)
- Gates: `smoke-js.mjs` — 5 legs: demos 1–3 (script exec + console +
  document.write; click→counter, which monkey CAN drive, see §8.1; canvas
  ImageData + timer repaint), the 10 s watchdog, the Choices off-switch.
  Plus `tests/kernel/test_netsurf_js_e2e.js` for what only the real frontend
  can prove: JS on by DEFAULT, timer-driven repaint through
  invalidate→damage→blit, a real SDL click reaching a DOM listener, and
  `${HOME}/.netsurf/Choices` turning it all off.  Image version bumped to
  164.  Demo *seeding* (`/usr/share/netsurf-demos/` + Demos menu) stays
  Lane E; the e2e plants its page itself so it does not wait on that.
- Cost accepted (measured, table above): +2.32 MB wasm, +30 s compile.

**Lane B — mutation → re-box → reflow → repaint bridge (M-L, the big one).**
**DONE 2026-07-26** — the design below landed as written; §9 records what
this lane found the plan (and the spike) had wrong, and what it left open.
Demos 4–5 (`stopwatch.html`, `todo.html`), `smoke-js.mjs` legs 6–8 (leg 8
is the A/B baseline, built with the bridge compiled out) and
`tests/kernel/test_netsurf_mutation_e2e.js` are the gate.
Design: one choke point `html_schedule_reconvert(htmlc)` — the libdom
default-action handlers (`dom_event.c`) call it for the *generic* node
insert/remove/modify cases (post-parse only, `htmlc->parser == NULL` guard);
it coalesces via `guit->misc->schedule(0, …)` (double-fire safe — the
scheduler dedups callback+arg pairs) and then: re-run `dom_to_box` on the
live document, swap the box tree, `content_reformat`, invalidate-all.
Whole-document re-box per mutation batch is the honest v1 of this lane —
correct first, incremental subtree re-box later if demos need it (measure:
layout of demo-scale pages is ms-class).  Open engineering inside the lane:
teardown of the old box tree on a LIVE content (form gadget re-binding,
imagemap frees, selection/scroll preservation — `html_destroy` shows the
free list).  Also fires the newly-inserted-subtree `on*` registration
(already exists: `dom_event.c:640`).  Gate: demos 4–5 + a kernel e2e leg
asserting a timer-driven textContent change repaints (pixel probe).

**Lane C — UI event coverage (M).**
`interaction.c` fires the missing DOM events through the existing
`fire_generic_dom_event`/`fire_dom_keyboard_event` plumbing (`html.c:111`,
`:133`): mousedown/mouseup/mousemove (with coords — needs a
`fire_dom_mouse_event` that fills MouseEvent init: the KeyboardEvent
precedent shows the shape), dblclick, keyup, `input`/`change` from the
form-gadget editing path, cancelable `submit` before native `form_submit`
(`interaction.c:1412`), focus/blur, wheel.  Un-cripple `js_fire_event`
(`dukky.c:1567`) to dispatch arbitrary targets/types.  Rate note: mousemove
under the 10 ms setTimeout clamp is fine; JS handlers run on the main loop —
keep dispatch behind "listeners registered" checks (dukky already tracks
registration) so non-JS pages pay nothing.  Gate: demo 6's input half;
event-order unit-ish e2e via console sentinels in smoke-js.

**Lane D — binding fills (M-L, item-parallel).**
Priority order, each a `.bnd` body + regen (committed output makes diffs
reviewable):
1. Canvas 2D drawing primitives: fillStyle/strokeStyle (color parse —
   css color code exists in-tree), fillRect/strokeRect/clearRect, path API
   (moveTo/lineTo/arc/rect/fill/stroke), drawImage(canvas|img), fillText
   over the existing content text plotters if cheap, else descope text with
   a note.  The bitmap is a plain pixel buffer; netsurf already has software
   plotters to crib from.  putImageData's modified+redraw_node tail is the
   repaint pattern to reuse.
2. `requestAnimationFrame` over `schedule` (Window.bnd; 10 ms floor ≈ 100 Hz
   cap, fine) — honest rAF timestamps via `nsu_getmonotonic_ms`.
3. `document.title` get/set (libdom has html_document title API) — also
   makes a great e2e assert (gucOS window titles already track `<title>`).
4. `innerHTML` getter (recursive serializer — libdom has none; small,
   self-contained).
5. `querySelector`/`querySelectorAll`: full CSS-selector matching via a
   dedicated matcher over libdom is the right-generality build; libcss's
   select engine is stylesheet-oriented, so evaluate first whether it can
   answer per-element "matches selector?" queries (spike inside the lane);
   if not, write the matcher for the selector grammar subset libcss parses.
   Surface the scope decision in the lane item — do not silently ship
   #id-only.
6. getComputedStyle read-back (needs B's fresh layout) — follow-on item.
Gate: demos 6–7.

**Lane E — gucOS demos + seeding + tests (S-M, scaffold parallel with A).**
**DONE** — but NOT as sketched here.  The seeding route changed: the pages
are not baked into `/usr/share/netsurf-demos/` with Demos menu entries;
they ship as `packages/netsurf-demos.json`, a preinstalled package using
the gucman `seed` CONTENT resource kind (design:
`gucman-content-resource-design.md` §7 stage 5), which plants them as
**editable copies the user owns** at
`~/Desktop/Presentations/samples/Web Demos/`.  A read-only baked copy
would have been the wrong artifact for demo content — the point is that
you can change one.  No menu entry and no `desktop:{cmd}`: there is
nothing executable to point at, and `.html` already opens through the
`html` openwith association.

The pages were also restructured — one folder per demo, with a real
external stylesheet and external script each (`vendor/netsurf/demos/`
README).  That closed a genuine hole: with everything inline, nothing in
the tree exercised subresource loading, and `<script src=>` turned out to
be silently discarded (`js` missing from the frontend mime table; fixed in
`patches/netsurf.diff`).

Gates: `smoke-js.mjs` leg 0 (the demo-set contract + coverage) and the
per-demo subresource checks, plus
`tests/kernel/test_netsurf_demos_e2e.js` — a fresh fat boot carries every
declared file byte-for-byte and every seeded demo really runs in a real
window, with negative controls.

Sequencing: **A → {B ∥ C ∥ D} → E-final** (E scaffold + demos 1–3 land with
A).  A is small and unblocks everything; B is the schedule-critical path for
"interactive demo apps" in the DOM-UI sense.

## Risks & caveats (ranked)

1. **Lane B live re-conversion unknowns** — re-running `dom_to_box` on a
   converted content was never done upstream; teardown/rebind details could
   inflate the lane.  Resolve with a 1-day spike (monkey harness, demo 4).
2. **Upstream stub landscape** — more silent no-op bindings will surface as
   demos grow (title was caught live).  Mitigation: every demo asserts
   its output (console sentinel/pixels), never assumes a binding works.
3. **Perf** — duktape interpreting JS on top of our ~5.5×-slower-than-clang
   codegen; fine for demo-class apps (probe: 1e5-iteration loop instant),
   but canvas-game framerates need measuring in Lane D/E; not a correctness
   risk.
4. **A runaway script blocks the netsurf main loop for up to 10 s**
   (single-threaded by design; watchdog then aborts).  Acceptable — the OS
   stays responsive (netsurf is one process); document in the demo README.
5. **Image size** — +2.35 MB on the baked blob and prod fetch; accepted
   cost, note in the deploy log.

## What was NOT determined (and how to resolve)

- Live-content re-box lifecycle details (risk 1) — spike opens Lane B.
- Whether libcss's select engine can serve per-element selector matching
  (Lane D item 5's internal spike).
- Real pointer-driven click latency/ordering in the gucOS window (monkey has
  no pointer injection; code path is verified, live proof lands with the
  Lane A kernel e2e).
- Deep-recursion ceiling: 5000 frames verified; duktape's own limits vs the
  wasm stack beyond that unprobed (demo-irrelevant).
- Nothing in the v1 (JS-off) path regressed during probing — baseline smoke
  re-run green; no P0s found.

## Reproduction (post-Lane A)

Nothing volatile is needed any more — the graft is committed and the
generator is pinned.

- Every live-JS claim: `node vendor/netsurf/smoke-js.mjs` (add `--reuse`
  while iterating; it refuses a stale wasm rather than trusting one).
- One demo by hand: `node vendor/netsurf/smoke.mjs --build`, then
  `node host.js build/netsurf-smoke/nsmonkey.wasm --enable_javascript=1`
  with `NETSURFRES=build/netsurf-smoke/res/` and `WINDOW NEW file://…` on
  stdin.
- In the OS: `node tests/kernel/test_netsurf_js_e2e.js` (~5 s against a
  prebaked fixture).
- Regenerating bindings: `BISON=… vendor/netsurf/regen-js-bindings.sh`
  (pins in `UPSTREAM.json`'s `tools`; `--check` is the drift gate).  The
  probe's `/tmp/netsurf-js-scope/` bison-3.8.2 build is gone/volatile —
  the script prints how to rebuild one.

## 9. What Lane B found that this document (and the spike) had wrong

Recorded so C, D and E plan against reality.  The spike's own residual list
lives in `logs/2026-07-26/netsurf-lane-b-spike.md`; this is the delta after
building the real lane on top of it.

1. **Scroll preservation was never verified, and now is.**  The spike
   reasoned it was "preserved by construction — frontend-owned and
   document-relative" from a CODE READ only, and explicitly deferred the
   live check.  It is genuinely preserved, but that is now a measurement:
   `test_netsurf_mutation_e2e.js` scrolls a colour-coded ruler page by 700
   px, DECODES the offset back out of the screenshot either side of two
   re-conversions, and requires it unchanged and non-zero.
2. **Focus is a box-tree pointer too, and the spike's teardown dropped
   it.**  `html_content.focus_owner.textarea` is a `struct box *`, so the
   re-conversion reset it to `HTML_FOCUS_SELF` exactly like the selection —
   but unlike the selection nothing handed it back.  Consequence, measured:
   typing six characters into a field on a page whose timer mutates an
   unrelated element landed **52 ink pixels vs 285** on an otherwise
   identical still page, i.e. every keystroke after the first mutation was
   dropped.  Any page that edits the DOM while the user types was
   unusable.  Fixed by saving the focused gadget's DOM node plus its caret
   index before teardown and re-binding both to the new box after the swap
   (`reconvert_focus_node`); the A/B is now 285 vs 285 and is a committed
   leg.  This needed one new public accessor, `textarea_get_caret_char`,
   the inverse of the existing `textarea_set_caret`.
3. **Gadget reuse needed three fixes, not just the spike's inventory.**  A
   gadget survives re-boxing by design, but three things hanging off one
   did not: `<select>` refilled its option list from the DOM on every
   re-box without emptying it first (duplicate options accumulated —
   `form_select_clear_options`); `box_textarea_create_textarea` overwrote
   `data.text.ta`/`data.text.initial` rather than releasing them (a leaked
   textarea plus a leaked `dom_string` ref per re-box); and a control
   outside any `<form>` was owned by NOBODY, so it could not be re-found
   and a fresh one was invented per re-box (now adopted onto the content as
   `formless_controls` — which also fixes an upstream leak at destroy,
   since nothing freed them before either).
4. **The NULL-box class is one choke point, not scattered guards.**  The
   spike flagged `form_radio_set` for a missing `control->box` check.  Every
   such dereference funnels through `html__redraw_a_box`, so the guard
   lives there once: a gadget with no box (mid-re-conversion, or
   `display:none`) is a legitimate "nothing to redraw".
5. **`keydown` is dispatched at the document ROOT, and Enter has no key
   name.**  `interaction.c` fires it at `html->layout->node`, not at the
   focused element, so a listener must sit on `document`/the root element.
   And `fire_dom_keyboard_event`'s special-key table (`html.c`) has no
   `NS_KEY_CR`/`NS_KEY_NL`/`NS_KEY_TAB` case, so Enter reaches JS with
   `event.key === null` — §6's demo-5 sketch assumed "text input +
   Enter/keydown" and that half is **not possible today**.  `todo.html`
   adds with a button instead.  Both are Lane C's to fix.
6. **`Date.now()` has one-second resolution.**  duktape's platform probe
   does not recognise this target and falls through to its "unknown OS"
   branch (`duk_config.h:853` → `DUK_USE_DATE_NOW_TIME` → `time()`).
   Verified: 200 000 consecutive `Date.now()` calls returned ONE value, and
   it ended in `000`.  Our libc's `gettimeofday` does have real microsecond
   resolution (checked directly), so the fix is one line in `duk_custom.h`
   (`#define DUK_USE_DATE_NOW_GETTIMEOFDAY`).  Not taken here because it
   changes JS `Date` semantics estate-wide and wants its own verification —
   Lane D.  `stopwatch.html` counts `setInterval` ticks instead.
7. **Mutations made during the parse are NOT bridge traffic.**  Script that
   runs at load mutates the DOM while `htmlc->parser != NULL`, so
   `html_schedule_reconvert` declines and the normal load-time conversion
   picks the change up.  Useful (a page can seed itself and still render
   with the bridge off) but it means a demo whose only mutations happen at
   script-execution time proves NOTHING about this lane — which is exactly
   why `todo.html`'s seed rows are the control and only the post-load
   clicks are the proof.
8. **The bridge has a build-time kill switch, and the gate uses it.**
   `-DNETSURF_NO_LIVE_RECONVERT` makes `html_schedule_reconvert` a no-op,
   restoring upstream behaviour.  `smoke-js.mjs` leg 8 builds that variant
   from the same tree and requires the same two demo pages to plot NOTHING
   changing (while their JS handlers still demonstrably run).  A demo that
   passes with and without the change proves nothing; this is what stops
   that.
9. **Still open, deliberately.**  Whole-document re-box per mutation batch
   is the shipped v1 (~1 ms at demo scale; ~152 ms at 1508 elements,
   dominated by `convert_xml_to_box`'s yield-every-10-nodes scheduler
   round-trips rather than compute — a reconvert-tuned
   `max_processed_before_yield` is the obvious knob if a demo ever needs
   it).  `html->forms` is still built once at `begin_conversion`, so a
   JS-inserted `<form>` is not a real form and its controls get invented
   gadgets.  Dynamically-inserted stylesheets still hit the static
   `select_ctx` wall — the reconvert path is where a `select_ctx` rebuild
   would slot in.  Caret position is preserved across a re-box but the
   textarea widget itself is still rebuilt, so an in-progress *selection*
   inside a field is not.
