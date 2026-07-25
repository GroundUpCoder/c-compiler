# NetSurf JavaScript demo pages

The acceptance ladder from `todos/NETSURF-JS.md` §6.  These three are the
rungs **Lane A alone** can satisfy, and `../smoke-js.mjs` drives all of them
as the lane's gate (legs 1–3):

| page | proves |
|---|---|
| `hello-js.html` | the engine runs a `<script>`, `console.log` reaches the frontend, parse-time `document.write` is parsed and laid out |
| `counter.html` | real DOM `click` listeners fire **exactly once**, and writing `input.value` repaints |
| `sketch.html` | `getContext("2d")` + `createImageData`/`putImageData` + `setInterval` — a canvas that repaints from a timer with **zero** user input |

Rungs 4–7 of the ladder (`stopwatch`, `todo`, `paint`, `breakout`) are
deliberately absent: each needs a later lane (the mutation→reflow bridge,
wider UI-event coverage, canvas drawing primitives / rAF).  Do not add a
page here that its lane cannot honestly satisfy.

Seeding these into the OS image at `/usr/share/netsurf-demos/` plus Demos
menu entries is **Lane E**, not done here.  `tests/kernel/test_netsurf_js_e2e.js`
plants `sketch.html` into `/root` itself, so the in-OS proof does not wait
on the seeds.

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
- **Structural DOM mutation does not repaint.**  `createElement` +
  `appendChild` succeed and the DOM really changes, but no box is built and
  nothing is drawn.  The channels that DO repaint are form-control
  `value`/`checked` and canvas `putImageData`; that is why `counter.html`'s
  readout is an `<input>`.
- **Only `click`, `keydown` and window `load` are ever dispatched.**  No
  `mousedown`/`mousemove`/`mouseup`, no `keyup`, no `change`/`input`/
  `submit`, no `focus`/`blur`.
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
