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

## What is deliberately NOT here yet

- SDL from Python: pygame is not built (`docs/CPYTHON.md` §8). The page's
  SDL plumbing (OffscreenCanvas hand-off, `SDL_WEB` input forwarding, shared
  audio ring) is wired so step 3 lands on top of it.
- A blocking `while True: flip()` loop cannot present on this page today:
  the standalone browser flavor is callback-model, `SDL_Delay` throws and a
  blocked worker never commits an OffscreenCanvas frame. Step 2.
