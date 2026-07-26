# 0290 — NetSurf Lane D — binding fills (canvas2D, rAF, document.title, innerHTML getter, querySelector, Date.now resolution)

- **Status**: open
- **Design**: `todos/NETSURF-JS.md` §"Lane D — binding fills" (priority-ordered list there;
  item-parallel — the sub-items are largely independent).

## Goal

Fill the missing Web-API bindings so real pages work. Each item is a `.bnd` body + regen
(committed generated output keeps diffs reviewable).

Filed 2026-07-27 for the same reason as `0289`: Lane D was "open" in a topic doc and absent
from `todos/`, i.e. unscheduled work that read as scheduled.

## Scope (priority order, from the design doc)

1. **Canvas 2D drawing primitives** — `fillStyle`/`strokeStyle` (CSS color parse code exists
   in-tree), `fillRect`/`strokeRect`/`clearRect`, path API
   (`moveTo`/`lineTo`/`arc`/`rect`/`fill`/`stroke`), `drawImage(canvas|img)`, `fillText` over
   the existing content text plotters **if cheap — else descope text with a note**. The bitmap
   is a plain pixel buffer and netsurf has software plotters to crib from;
   `putImageData`'s modified + `redraw_node` tail is the repaint pattern to reuse.
2. **`requestAnimationFrame`** over `schedule` (Window.bnd; 10 ms floor ≈ 100 Hz cap, fine),
   with honest rAF timestamps via `nsu_getmonotonic_ms`. Note `requestAnimationFrame` is
   **not** implemented upstream (idl-only).
3. **`document.title` get/set** (libdom has the html_document title API). Also a good e2e
   assert: gucOS window titles already track `<title>`.
4. **`innerHTML` getter** — recursive serializer; libdom has none. Small and self-contained.
5. **`querySelector`/`querySelectorAll`.**
6. **`getComputedStyle` read-back** — needs Lane B's fresh layout; follow-on item.

## 🔴 SHORTCUT-WATCH on item 5 — do not let this ship #id-only

Full CSS-selector matching over libdom is the right-generality build. libcss's select engine is
**stylesheet-oriented**, so the lane must **first spike whether libcss can answer a per-element
"does this element match this selector?" query**. If it cannot, write a real matcher for the
selector grammar subset libcss parses.

**The scope decision must be surfaced in this item, explicitly.** An `#id`-only
`querySelector` that quietly calls itself done is exactly the shortcut `CLAUDE.md`'s CORE
PRINCIPLE rejects — "all current demos happen to use `#id`" is not a valid reason to narrow it.
Record the spike's answer here either way, so a later reader knows whether the narrow scope was
*chosen* or merely *reached*.

## Cheap win worth doing first

**`Date.now()` has 1-second resolution** (`duk_config.h:853`). Any animation or timing demo is
broken by that alone, and it is a one-liner relative to the rest of the lane.

## Why this matters beyond the browser

Like `0289`, Lane D **unblocks withheld demos** — `paint.html` and breakout need canvas2D and
rAF. These two lanes together are the gate on shipping them.

## Acceptance

- Per the design doc's gate: **demos 6–7** work.
- `Date.now()` has sub-second resolution, asserted by a test.
- Item 5's selector scope is stated in this file with the spike's finding, and matching is
  general to the documented subset — not `#id`-only.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
