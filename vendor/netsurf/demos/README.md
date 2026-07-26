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

Rungs 6–7 (`paint`, `breakout`) are still deliberately absent: they need
Lane C's mouse coordinates and Lane D's canvas drawing primitives / rAF.
**Do not add a page here that its lane cannot honestly satisfy** — and do
not ship a stubbed version of one that cannot work.

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
- **Only `click`, `keydown` and window `load` are ever dispatched.**  No
  `mousedown`/`mousemove`/`mouseup`, no `keyup`, no `change`/`input`/
  `submit`, no `focus`/`blur`.
- **`keydown` is fired at the document ROOT, not at the focused element**,
  so a listener has to sit on `document` (or the root element) — one on the
  `<input>` never runs.  And **Enter arrives with `event.key === null`**:
  the special-key table in `html.c`'s `fire_dom_keyboard_event` has cases
  for Escape/arrows/Home/End/PageUp/PageDown but none for `NS_KEY_CR`, so
  Enter (and Tab, and Backspace) fall through to a NULL key string.  That
  is why `todo/` adds with a button, not with Enter.  Printable keys are
  fine (`event.key === 'a'`).
- **`Date.now()` has ONE-SECOND resolution.**  duktape's platform probe
  does not recognise this target, falls through to its "unknown OS" branch
  (`duk_config.h` → `DUK_USE_DATE_NOW_TIME`) and ends up on plain `time()`.
  Our libc's `gettimeofday` *does* have microsecond resolution, so this is
  a one-line `duk_custom.h` fix (`#define DUK_USE_DATE_NOW_GETTIMEOFDAY`)
  for whoever owns the bindings.  Until then, anything wanting sub-second
  timing must count `setInterval` ticks — which is what `stopwatch/` does.
- **Click events carry no coordinates.**  They are dispatched as plain
  `Event`s, not `MouseEvent`s, so `clientX`/`pageX` are `undefined` — a
  draw-where-you-clicked canvas is not possible yet.
- **Capture-phase listeners never fire**, and worse: registering a
  `{capture: true}` listener on an element silently disables every later
  non-capture listener for that same event type on that element (the
  per-node registration is keyed by event name only).  Use bubble-phase
  listeners exclusively.
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
