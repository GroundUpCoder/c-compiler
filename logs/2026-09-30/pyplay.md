# pyplay — the standalone Python page (Epic 2 kick, step 1)

jku's ask (2026-09-30): combine the SDL3 veneer and the clang-built CPython
into "a dedicated page without all the os/ machinery that allows just
dropping a zip file containing pygame python scripts and just have it run in
the browser", then "DO IT". That is the queued CPython+pygame epic
(`docs/GAMEDEV-EPIC.md` Epic 2), which starts only on his say — this is it.

The work is staged so each step ships something real:

1. **the page** running the existing `cpython-clang` package (this entry);
2. the blocking-loop transport for SDL programs on that page;
3. pygame-ce statically linked into the interpreter against the SDL3 veneer.

## What landed

`apps/pyplay/` (`index.html`, `pyplay.js`, `pyplay-worker.js`, README) and
`tests/browser/os-pyplay.mjs`, plus a `tests/run.js` rule mapping
`apps/pyplay/` to the sweep.

## Decisions

- **The package repo is the artifact source, not a new bundle.** The page
  fetches `/packages/index.json`, verifies the payload sha, gunzips with
  `DecompressionStream`, reads the ustar in JS, and installs at the SAME
  `/opt/cpython-clang` prefix gucman uses. One producer (`tools/mkpkg.js`),
  one artifact, and the interpreter's argv0 landmark walk works unchanged.
  When the pygame flavor exists it is just another package entry.
- **`apps/` is the home** (global layout rule: applications live under
  `apps/`). It is the first `apps/` directory in this repo; `os/` is not
  migrated, per the rule's "when that repository's cleanup is in scope".
- **One worker per run, handle closed before `exit`.** The first cut let the
  main thread `terminate()` the worker on exit; the next run's
  `createSyncAccessHandle` then collided with a handle Chromium releases
  asynchronously (leg C red). The worker now flushes and closes the handle
  itself before posting `exit`, and acquisition retries briefly for the Stop
  path, where termination is the only option.
- **Stdin is the live-stdin SharedArrayBuffer ring** BlockFS already speaks
  (`setStdinSab`, the SI_* header), with the cooked line discipline on the
  page side and `SI_TERMIOS` switching it to raw. This works with or without
  JSPI — the worker parks on the SEQ futex — so `input()` is fine on Safari
  too. The emitted page uses the JSPI `requestStdin` promise path instead.

## Gotchas found

- **`BLOCK_FS.init` formats the LEGACY v3 layout.** v3 has no `/dev` nodes
  (they are materialised on v4 mounts only, `ensureDevNodes`), and this
  CPython build has `HAVE_GETENTROPY`/`HAVE_GETRANDOM` undefined, so
  `_Py_HashRandomization_Init` reads `/dev/urandom` and dies with
  "failed to get random numbers" on a v3 image. The page mounts a v4
  volume through `createV4(new SyncAccessHandleStore(handle))`. Two
  follow-ups worth tickets: (a) the compiler-emitted single-file page still
  uses `BLOCK_FS.init`, so any C program that opens `/dev/urandom` there
  fails the same way; (b) the libc exposes `getentropy()` and host.js backs
  it with a real CSPRNG (`__getentropy`, docs/archive/0325) — the CPython
  build should define `HAVE_GETENTROPY` so entropy stops depending on
  filesystem layout. Both are for the step-3 rebuild / a separate lane.
- **3.13 colorizes tracebacks** when stderr is a tty and `TERM` is set. The
  test strips ANSI before matching; the page shows the colors.
- **`makeCheck` in os-harness is `(name, cond, extra)`** and returns
  `{check, state}`, not `{check, failures}`; the file keeps a local helper.
- The first serve of the minimal image re-bakes (~35 s) because `host.js`
  changed on 2026-09-28 (IBFS); the test's `waitForServer` allows for that.

## Measured

Leg A on a cold origin: download 4.4 MB, unpack 551 files into OPFS, boot
CPython, run a multi-file program with `input()`, exit 3 — under the 60 s
output wait with margin. Second run: no download, no unpack (negative
control on the status events).

## Step 2 — the page as display server (same day)

The blocker for a Python game loop was the loop shape: the standalone
browser SDL flavor is callback-model (`SDL_Delay` throws, a worker parked
in `main()` never commits an OffscreenCanvas frame), and an interpreter
cannot be restructured into `SDL_AppIterate`. Two routes were on the table:

- **JSPI**: make the standalone flavor's present/delay imports suspending
  so the worker's event loop turns per frame. Chrome-only today (Safari has
  no JSPI), and it would be a second mechanism next to the one gucOS has.
- **The gucOS transport with the page as the kernel**: host.js's surface
  flavor (`createSurfaceSDL`) already does exactly what is needed — shm
  mailbox presents, ring input, futex parks for `SDL_Delay`/`WaitEvent`,
  a vsync word — against a `hooks` object. Its consumer is a compositor +
  input bridge, which under gucOS is kernel.js + compositor.js, and on this
  page is ~150 lines of main-thread JS.

The second route landed: **one transport, two embedders**, no JSPI, works
wherever `Atomics.wait` works in a worker. Concretely:

- `pyplay-worker.js` `makePageHooks(state, fs)` implements the surface
  hooks (create/destroy/configure/resize/flags/cursor/visible/state/frame),
  `screen`, the vsync trio (`vsyncEnabled`/`vsyncSeq`/`vsyncWait`/
  `vsyncWaitUntil`, KernelClient's ARMED discipline over a page-state SAB),
  `waitMulti` (ring ⊕ stdin ⊕ timeout, 50 ms slices when two futexes are
  in play), `exit`, and the audio trio. `spawn`/`wait`/`kill` answer
  ENOSYS/ECHILD/ESRCH — there is no process broker here, and the surface
  flavor is selected by runModule purely on `hooks.surfaceCreate`.
- `pyplay.js` composites under `SH_LOCK` with compositor.js's try-lock
  discipline (never wait on the producer; contention keeps the previous
  frame), writes ring records in `_wmPushEvent`'s shape (drop-newest,
  notify WPOS) with `SDL_WEB` deriving scancode/keysym/mod, bumps the vsync
  word per rAF, and runs one `createAudioReceiver` per device ring — the
  surface flavor's per-device rings share the standalone ring layout, so
  the receiver plays them unchanged (the "sink spec = requested spec" dummy
  driver contract; Web Audio resamples per AudioContext).
- The ring keeps ONE producer: the worker's `surfaceResize` posts the
  request and the page pushes the `WINDOW_RESIZED` record.
- `host.js`: the layout table `assertWmSabLayout` compares against is now
  the named constant `WM_SAB_LAYOUT_HOST`, so a kernel-free embedder can
  hand the host's own table back as `hooks.wmSabLayout`. There is no second
  declaration to drift from on this page, so that is honest, not a bypass;
  kernel.js keeps its copy and the tripwire keeps catching that drift.
  Semantically a no-op refactor; it still draws the whole estate as a gate.
- GPU tier: when `navigator.gpu` exists in the worker the browser branch of
  the surface flavor is chosen (SDL_Renderer on WebGPU, ImageBitmap frames
  via `surfaceFrame`, which the page `drawImage`s) with the #551 blocking-
  present refusal intact — one program behaves the same here and on gucOS.
  Without it, the headless branch's software renderer serves.

Tested by leg E of `os-pyplay.mjs`: a classic blocking C loop
(`fixtures/pyplay-sdlbox.c`, built by the test with this repo's compiler,
dropped as a `.wasm` entry) presents red, turns green on a key (scancode 4,
sym 97 through the ring), reports a click at the inverse-mapped centre,
keeps presenting through `SDL_Delay` (60+ frames), and exits 0 on the QUIT
record the Stop button sends.

## What is deliberately NOT here yet

- SDL from Python: pygame is not built (`docs/CPYTHON.md` §8). Step 3.
- One top-level window per page: extra windows composite on top at their
  own size. A real multi-window layout is the OS's job, not this page's.
- Gamepads and clipboard: the hooks answer empty; both are additive later.
