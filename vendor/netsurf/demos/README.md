# NetSurf demo pages

The acceptance ladder from `todos/NETSURF-JS.md` §6, and — since the
`netsurf-demos` package — the pages gucOS ships to users.

## Shape: `pages/`, one folder per demo, nothing inline

```
pages/
  index.html  index.css  index.js      the landing page
  hello-js/   index.html  hello-js.css  hello-js.js
  counter/    …
  sketch/     …
  stopwatch/  …
  todo/       …
```

`pages/` is exactly what `packages/netsurf-demos.json` ships
(`{"tree": "vendor/netsurf/demos/pages"}`) and seeds, as editable copies,
at `~/Desktop/Presentations/samples/Web Demos/`.  Every demo is a
**self-contained folder**: its subresources are folder-local, so one folder
can be copied anywhere and still work.  That is why the small common block
at the top of each `.css` is duplicated rather than shared — portability
beats DRY for content a user owns.

**Nothing is inline.**  Before this shape every demo carried its CSS in a
`<style>` block and its JS in an inline `<script>`, so nothing in the tree
exercised subresource loading at all — and it turned out to be broken:
`<script src=>` fetched and was then silently discarded, because `js` was
missing from the frontend's mime table (fixed; see `../README.md`'s
netsurf-core patch list, and `patches/netsurf.diff`).  Keeping the demos
external is what keeps that fixed.

### The load-check pill

Every page carries one line under its heading:

```html
<p class="loadcheck"><span id="nocss">stylesheet did not load — </span><span id="jswatch">script did not run</span></p>
```

- the external stylesheet hides `#nocss` and paints `#jswatch` **red**;
- the external script rewrites `#jswatch` to "script ran" and turns it
  **green** (`#jswatch.ran` — an id+class rule, because a bare `.ran`
  loses the specificity fight with `#jswatch`).

So the page states its own truth in all three states: no stylesheet =
plain text saying so, stylesheet but no script = a red pill, both = a green
pill.  Both edits happen while the parser is still live, so they arrive
through the normal load-time box construction and the pill works even in
the Lane-A-only (`-DNETSURF_NO_LIVE_RECONVERT`) build.

That one line is also the whole test surface: `smoke-js.mjs` reads it off
the plot stream (text present/absent) and
`tests/kernel/test_netsurf_demos_e2e.js` counts its pixels in a real
window.  **The two colours are load-bearing** — they are chosen disjoint
from every pixel the sketch canvas can draw, so counting them over the
whole window is safe.  Retune them together with that test.

## One source of truth: `demos.js`

The demo set is not a list anywhere.  It IS the set of directories under
`pages/`, and `demos.js` is the one module that says so.  Every gate reads
from it:

| consumer | uses |
|---|---|
| `../smoke-js.mjs` | leg 0: `checkContract()` + "every demo has a leg"; per-demo paths |
| `tests/kernel/test_netsurf_demos_e2e.js` | the demo set, titles, and subresource names |
| `tests/kernel/test_netsurf_js_e2e.js`, `test_netsurf_mutation_e2e.js` | `demoFiles()` — they plant a whole demo FOLDER |
| `tests/kernel/lib/drive.js` `pkgSeedPlants()` | derives the planted `/root` paths from the package + the tree |

`checkContract()` fails loud if a demo has no `index.html`, no external
stylesheet, no external script, a subresource reaching outside its folder,
no load-check pill, or is missing from `pages/index.html`'s link list.
Adding a folder under `pages/` therefore enters every gate at once — and
adding one without a `smoke-js.mjs` leg is a FAILURE, not a silent gap.

## What each page proves

Rungs 1–3 are what **Lane A alone** can satisfy (smoke-js legs 1–3):

| page | proves |
|---|---|
| `hello-js/` | the engine runs an EXTERNAL `<script src>`, `console.log` reaches the frontend, parse-time `document.write` from that external script is parsed and laid out in document order |
| `counter/` | real DOM `click` listeners fire **exactly once**, and writing `input.value` repaints |
| `sketch/` | `getContext("2d")` + `createImageData`/`putImageData` + `setInterval` — a canvas that repaints from a timer with **zero** user input |

Rungs 4–5 need **Lane B**, the mutation → re-box → reflow → repaint bridge
(legs 6–7, with leg 8 as the A/B baseline):

| page | proves |
|---|---|
| `stopwatch/` | a `setInterval` writing a plain `<div>`'s `textContent` moves the number **on screen**, and `createElement`+`appendChild` adds a visible lap row.  Neither is a form control nor a canvas — nothing about them repainted before Lane B |
| `todo/` | `removeChild` unpaints a row, and the counter re-renders both its **text** and its **class** (an attribute change that has to re-select styles, not just re-lay-out) |

Rung 6 needs **Lane C**, the UI event coverage (todos/0289), plus the
`events/` page that lane added to state what the browser now delivers
(legs 9–11, with leg 11 as the A/B baseline built with the events compiled
out):

| page | proves |
|---|---|
| `paint/` | `mousedown`/`mousemove`/`mouseup` are dispatched at all AND carry `pageX`/`pageY` — a drag paints where the pointer went.  `preventDefault()` on the mousedown takes the gesture, which is what stops the browser turning press-and-move into a page-scroll drag |
| `events/` | capture runs outer→middle BEFORE the target and bubble comes back after it (a capture AND a bubble listener on each of three nested boxes — the pair that used to leave an element completely deaf); `keydown`/`keyup` reach the FOCUSED field with a real `event.key` for Enter; `input`, `change` on blur, a cancelable `submit`, and `window.addEventListener("load")` |

`plasma/` (leg 12) is the headline canvas demo: a 320x200 demoscene plasma
animating from `setInterval` alone, palette-switched by click.  It proves
nothing new about the engine — it exists so a user who opens ONE page sees
real-time graphics with no interaction at all (todos/0425: the paint demo
used to open blank, and a user who only clicked reported it broken).  The
`paint/` page opens with a generated 512x512 scene for the same reason,
and both carry the pill-palette rule (see demos.js `PILL`).

Rung 7 (`breakout`) is still deliberately absent: it needs Lane D's canvas
drawing primitives and rAF.  **Do not add a page here that its lane cannot
honestly satisfy** — and do not ship a stubbed version of one that cannot
work.

## Writing pages for this engine — the sharp edges

Every one of these was hit while building the demos, so a page here must
assert its own output (a console sentinel or a pixel), never assume a
binding works.  The full audit is in `todos/NETSURF-JS.md` §5.

- **A global whose name collides with a Window IDL attribute is silently
  swallowed.**  `var frames = document.getElementById('frames')` leaves
  `frames` *undefined* — `Window.frames` is a generated no-op stub whose
  setter does nothing — and the script then dies at the first use, with the
  error only visible at NSLOG DEBUG level.  `length`, `name`, `status`,
  `top`, `self`, `parent`, `external` are the same shape.  Pick unusual
  variable names (`fpsBox`, not `frames`).
- ~~External `<script src=>` never executes.~~  **Fixed**: `js`/`mjs` now
  resolve to `text/javascript`.  Sync, `defer` and parse-time
  `document.write` from an external script all work; `<link
  rel=stylesheet>` always did.
- ~~Structural DOM mutation does not repaint.~~  **Fixed by Lane B**: any
  post-load mutation (insert, remove, character data, attribute) now
  re-boxes, re-lays-out and repaints the document.  `counter/`'s readout is
  still an `<input>` because it was written for Lane A, not because it has
  to be.  What is still true: mutations made *during* the parse land
  through the normal load-time conversion instead, so a page that only
  mutates at script-execution time proves nothing about the bridge.
- ~~Only `click`, `keydown` and window `load` are ever dispatched.~~
  **Fixed by Lane C**: mousedown/mousemove/mouseup (with coordinates),
  dblclick, keyup, input/change, a cancelable submit, focus/blur and wheel
  all fire.  What is still absent: `mouseover`/`mouseout`/`mouseenter`/
  `mouseleave` and `focusin`/`focusout` (todos/0317).
- ~~`keydown` is fired at the document ROOT, not at the focused element.~~
  ~~And Enter arrives with `event.key === null`.~~  **Both fixed by Lane
  C**: keys go to the focused element and bubble from there (so a
  `document` listener still sees them), and Enter/Tab/Backspace/Delete have
  their DOM `key` names.  `todo/` still adds with a button because it was
  written for Lane B, not because it has to.
- **`Date.now()` has ONE-SECOND resolution.**  duktape's platform probe
  does not recognise this target, falls through to its "unknown OS" branch
  (`duk_config.h` → `DUK_USE_DATE_NOW_TIME`) and ends up on plain `time()`.
  Our libc's `gettimeofday` *does* have microsecond resolution, so this is
  a one-line `duk_custom.h` fix (`#define DUK_USE_DATE_NOW_GETTIMEOFDAY`)
  for whoever owns the bindings.  Until then, anything wanting sub-second
  timing must count `setInterval` ticks — which is what `stopwatch/` does.
- ~~Click events carry no coordinates.~~  **Fixed by Lane C**: mouse events
  are real `MouseEvent`s with `pageX`/`pageY`, `clientX`/`clientY`,
  `button`, `buttons` and the modifier flags.  Note there is no
  `getBoundingClientRect` and no `offsetLeft`, so a page still has no way
  to ask where an element ENDED UP — `paint/` pins its canvas to the
  document origin with CSS so that a page coordinate IS a canvas pixel.
- ~~Capture-phase listeners never fire, and registering one disables every
  later listener for that type on that element.~~  **Fixed by Lane C**, and
  the second half was worse than described: ANY second `addEventListener`
  for a type already listened to on that element replaced the first,
  capture or not (two handlers on one button ran as one).
- **canvas 2D has no drawing primitives** — no `fillRect`, no paths, no
  `fillText`, no `drawImage`, no `fillStyle`.  Rasterise into an
  `ImageData` and `putImageData` it.
- **`document.title`'s getter and setter are empty stubs**, and
  `innerHTML`'s getter returns `""` (the setter is real).  No
  `querySelector`, `getElementsByClassName`, `requestAnimationFrame`,
  `Promise`, `fetch` or storage.
- A script gets **10 s** of execution per entry before the watchdog aborts
  it (`JS_EXEC_TIMEOUT_MS`), and it runs on the browser's only thread — a
  long loop freezes this one window (not the OS) until then.
