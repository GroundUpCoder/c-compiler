# NetSurf JS Lane B spike — live-content re-conversion works (YES-verdict)

Branch `netsurf-lane-b-spike` (off `netsurf-js-scope`).  Time-boxed spike
answering `todos/NETSURF-JS.md` risk #1: can a converted, live html content
re-run `dom_to_box` when JS mutates the DOM — mutation → re-box → reflow →
repaint — without the box-tree teardown killing everything that points into
it?

**Verdict: YES.**  Demo 4 (`test/stopwatch.html`, a setInterval textContent
counter) visibly updates in a monkey run (`spike-stopwatch.mjs`: counter
plots advance 1 → 6 → 10 across redraw frames; the unpatched baseline plots
`0` forever).  All 11 danger-zone probes pass (`spike-danger.mjs`).

## Design that landed (the doc's shape, validated)

One choke point `html_schedule_reconvert(htmlc)` (html.c), scheduled via
`guit->misc->schedule(0, …)` (dedup = coalescing), triggered from the
GENERIC libdom default-action cases in dom_event.c.  Key discovery:
libdom fires `DOMSubtreeModified` (targeting the PARENT element) for node
insertion, removal, characterdata changes AND attribute changes — one
generic hook covers every structural mutation class.  (`DOMNodeInserted`
also schedules, harmlessly — the scheduler dedups.)  INPUT/TEXTAREA
targets keep the existing texty-sync path (no re-box per keystroke);
STYLE keeps the stylesheet path; the title node keeps title handling.

Re-conversion is **build-then-swap**: teardown clears every pointer INTO
the old tree, then `c->bctx` is parked in `c->reconvert_old_bctx` and
NULLed so `dom_to_box` builds the new tree in a fresh talloc context while
the OLD tree keeps serving redraw and input; `convert_xml_to_box` swaps
`c->layout` at completion, and the completion callback frees the old
context, re-extracts imagemaps, reformats at the current viewport and
invalidates.  Guards: parser≠NULL/select_ctx==NULL/layout==NULL (pre-layout
mutations belong to the normal conversion), in-flight reconverts set
`reconvert_pending` and re-run at completion; `html_destroy` cancels the
scheduled pass and frees a parked old context.

Teardown inventory (each verified by probe or code-read):
- **node user data** (`box_for_node`): cleared by a full DOM walk — nodes
  that lose their box (removed / display:none) would dangle forever; both
  consumers (texty update, canvas redraw_node) NULL-check.
- **libcss per-node style cache**: cleared in the same walk via new
  `nscss_node_data_clear()` (css/select.c) with a proper
  `CSS_NODE_DELETED` free — netsurf's `set_libcss_node_data` ASSERTS no
  stale data (first live crash of the spike, assert at css/select.c:1747).
- **form gadgets**: survive by design — `html_forms_get_control_for_node`
  re-finds controls BY DOM NODE at re-box; teardown NULLs every
  `control->box` back-pointer first.  Values live in the DOM, so input
  text survives (probed: JS-set value repaints after the next re-box).
- **selection**: `selection_init()` (not just reinit) — `drag_state` is
  NOT cleared by `selection_reinit`/`selection_clear`, and a latched
  triple-click drag swallowed every later click (probe-found).
- **objects (images)**: closed + freed; re-box refetches through the
  hlcache.
- **imagemaps**: destroy + NULL (destroy doesn't NULL the hash — instant
  UAF otherwise) + re-extract at completion.
- **drag/focus/selection owner unions + visible select menu**: reset.

## Upstream landmine found (the spike's marquee bug)

`imagemap_addtolist` tokenized the coords attribute with
**`strtok((char *)dom_string_data(coords), ",")` — mutating the interned
DOM string in place**.  First extraction turns `"0,0,63,63"` into
`"0\0…"` inside the DOM; re-extraction parses a comma-less string and the
area collapses to 0,0,0,0 (probed: imagemap clicks dead after one re-box;
SPIKEDBG showed `rect=0,0,0,0`).  Upstream never noticed because
extraction ran exactly once per document.  Fixed: strtok a strdup'd copy.
This is the exact "never re-run upstream" bug class the lane must expect.

## Residuals for the full lane (honest, not blocking the verdict)

- `form_radio_set` has NO NULL check on `control->box`
  (form.c:2035-class): a checked radio hidden via display:none then a
  group click dereferences NULL.  Probed: under wasm this reads low
  memory instead of trapping (garbage invalidate rect, no crash) — still
  wants the 2-line guard.
- Select gadgets re-add their options per re-box (`box_select` →
  `box_select_add_option` on the reused control) — duplicate option list
  entries accumulate (code-read; invisible in plots).  Reset options on
  gadget reuse.
- Text gadget re-bind leaks the previous `textarea` widget +
  `data.text.initial` ref per re-box, and caret/edit state resets
  (value survives via the DOM).  Reuse or destroy the old ta.
- Formless inputs get a NEW gadget per re-box (only `c->forms` is
  searched for reuse) — leak per re-box; upstream already leaks these at
  destroy.  Demo pages should keep inputs in <form>; lane fix optional.
- `html->forms` is built ONCE at begin_conversion — a JS-inserted <form>
  is never a real form (its controls get fake gadgets).  Full lane could
  re-run `html_forms_get_forms` deltas if a demo needs it.
- Input during the async construction window routes against the OLD tree
  with gadget `box` pointers already NULLed — form paths (e.g. radio
  redraw) can hit the same NULL-box class.  Window is one scheduler pass
  per 10 DOM nodes; fix = the same NULL guards, or a synchronous drive.
- Dynamically-inserted STYLE/stylesheet changes still hit the
  "NS layout is static" select_ctx wall — untouched here (Lane B scope
  was structure, not restyle; the reconvert path is where a select_ctx
  rebuild would slot in).

## Perf (measured, M-series host, monkey)

- Demo-scale page (stopwatch, ~15 elements): **~1 ms** per full
  reconvert (teardown → re-box → swap → reformat → invalidate).
- 1508-element page (`test/spike-perf.html`): **~152 ms** per cycle, BUT
  dominated by `convert_xml_to_box`'s yield-every-10-elements
  scheduler round-trips (~150 passes ≈ ~1 ms each), not compute.  A
  reconvert-tuned `max_processed_before_yield` is the obvious knob.
  Mutations coalesce under a slow reconvert, so JS timer cadence holds
  (50 ms ticker: 51.3 ms avg measured) — the visible update just lags a
  batch.  A periodic exactly-1000 ms stall seen in monkey runs
  reproduces with a PURE timer page on the unpatched flow — monkey
  main-loop artifact, not the bridge.
- Whole-document re-box v1 is comfortably enough for demos 4-5; keep
  incremental subtree re-box as the later optimization the doc planned.

## Monkey-harness facts worth keeping

- `WINDOW EXEC` acks `JS WIN n RET TRUE` but the inserted script NEVER
  executes (pre-existing — reproduced on the unpatched baseline).  Drive
  JS via onclick handlers + `WINDOW CLICK` instead.
- `WINDOW CLICK` dispatches the DOM click TWICE per injected click
  (press+click; also baseline behavior) — handlers run 2×.
- Inline elements (span/a) never become the click target — hit-test
  resolves text runs to the block container (Lane C's event-target
  work).  onclick triggers in test pages must be BLOCK elements.
- Load-complete marker: `STOP_THROBBER` only counts AFTER the load's
  `START_THROBBER` (window creation emits a leading stop).

## Files

- `content/handlers/html/private.h` — reconvert state + decl
- `content/handlers/html/html.c` — the reconvert machinery
- `content/handlers/html/dom_event.c` — generic mutation triggers
- `content/handlers/css/select.{c,h}` — `nscss_node_data_clear`
- `content/handlers/html/imagemap.c` — strtok-corruption fix
- `vendor/netsurf/spike-stopwatch.mjs` + `spike-danger.mjs` — drivers
- `vendor/netsurf/test/{stopwatch,spike-danger,spike-perf}.html`

Gates run: `smoke.mjs` (JS-off v1 path) PASS, `spike-stopwatch.mjs` PASS
(+ `--expect-static` baseline proof), `spike-danger.mjs` 11/11 PASS.
Estimate for the full Lane B on this base: **S-M** (guards + gadget-reuse
warts + reconvert-tuned yield + promote drivers into the smoke-js/kernel
test tiers), down from the doc's M-L — the frightening unknowns are now
known.
