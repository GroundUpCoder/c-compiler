# NetSurf JavaScript demo pages

The acceptance ladder from `todos/NETSURF-JS.md` §6.  `../smoke-js.mjs`
drives every one of them as the lane gate.

Rungs 1–3 are what **Lane A alone** can satisfy (legs 1–3):

| page | proves |
|---|---|
| `hello-js.html` | the engine runs a `<script>`, `console.log` reaches the frontend, parse-time `document.write` is parsed and laid out |
| `counter.html` | real DOM `click` listeners fire **exactly once**, and writing `input.value` repaints |
| `sketch.html` | `getContext("2d")` + `createImageData`/`putImageData` + `setInterval` — a canvas that repaints from a timer with **zero** user input |

Rungs 4–5 need **Lane B**, the mutation → re-box → reflow → repaint bridge
(legs 6–7, with leg 8 as the A/B baseline):

| page | proves |
|---|---|
| `stopwatch.html` | a `setInterval` writing a plain `<div>`'s `textContent` moves the number **on screen**, and `createElement`+`appendChild` adds a visible lap row.  Neither is a form control nor a canvas — nothing about them repainted before Lane B |
| `todo.html` | `removeChild` unpaints a row, and the counter re-renders both its **text** and its **class** (an attribute change that has to re-select styles, not just re-lay-out) |

Rungs 6–7 (`paint`, `breakout`) are still deliberately absent: they need
Lane C's mouse coordinates and Lane D's canvas drawing primitives / rAF.
Do not add a page here that its lane cannot honestly satisfy.

Seeding these into the OS image at `/usr/share/netsurf-demos/` plus Demos
menu entries is **Lane E**, not done here.
`tests/kernel/test_netsurf_js_e2e.js` plants `sketch.html` and
`tests/kernel/test_netsurf_mutation_e2e.js` plants `stopwatch.html` into
`/root` themselves, so the in-OS proofs do not wait on the seeds.

## Writing pages for this engine — the sharp edges

Every one of these was hit while building the three demos, so a page here
must assert its own output (a console sentinel or a pixel), never assume a
binding works.  The full audit is in `todos/NETSURF-JS.md` §5.

- **A global whose name collides with a Window IDL attribute is silently
  swallowed.**  `var frames = document.getElementById('frames')` leaves
  `frames` *undefined* — `Window.frames` is a generated no-op stub whose
  setter does nothing — and the script then dies at the first use, with the
  error only visible at NSLOG DEBUG level.  `length`, `name`, `status`,
  `top`, `self`, `parent`, `external` are the same shape.  Pick unusual
  variable names (`fpsBox`, not `frames`).
- ~~Structural DOM mutation does not repaint.~~  **Fixed by Lane B**: any
  post-load mutation (insert, remove, character data, attribute) now
  re-boxes, re-lays-out and repaints the document.  `counter.html`'s
  readout is still an `<input>` because it was written for Lane A, not
  because it has to be.  What is still true: mutations made *during* the
  parse land through the normal load-time conversion instead, so a page
  that only mutates at script-execution time proves nothing about the
  bridge.
- **Only `click`, `keydown` and window `load` are ever dispatched.**  No
  `mousedown`/`mousemove`/`mouseup`, no `keyup`, no `change`/`input`/
  `submit`, no `focus`/`blur`.
- **`keydown` is fired at the document ROOT, not at the focused element**,
  so a listener has to sit on `document` (or the root element) — one on the
  `<input>` never runs.  And **Enter arrives with `event.key === null`**:
  the special-key table in `html.c`'s `fire_dom_keyboard_event` has cases
  for Escape/arrows/Home/End/PageUp/PageDown but none for `NS_KEY_CR`, so
  Enter (and Tab, and Backspace) fall through to a NULL key string.  That
  is why `todo.html` adds with a button, not with Enter.  Printable keys
  are fine (`event.key === 'a'`).
- **`Date.now()` has ONE-SECOND resolution.**  duktape's platform probe
  does not recognise this target, falls through to its "unknown OS" branch
  (`duk_config.h` → `DUK_USE_DATE_NOW_TIME`) and ends up on plain `time()`.
  Our libc's `gettimeofday` *does* have microsecond resolution, so this is
  a one-line `duk_custom.h` fix (`#define DUK_USE_DATE_NOW_GETTIMEOFDAY`)
  for whoever owns the bindings.  Until then, anything wanting sub-second
  timing must count `setInterval` ticks — which is what `stopwatch.html`
  does.
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
