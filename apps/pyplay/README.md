# pyplay — drop a zip of Python, run it in the browser

`apps/pyplay/index.html` is a standalone page. It runs a Python program on
the `cpython-clang` package (CPython 3.13 built by the clang sibling, real
stdlib) entirely inside the tab. It uses none of the gucOS machinery: no
kernel, no window manager, no compositor, no system image. It is the Python
twin of the compiler-emitted single-file `.html` runner.

Open `http://localhost:<port>/apps/pyplay/` from `node serve.js`, or the
same path on a deployed origin that publishes the package repo at
`/packages/`.

## What it does

1. **Load a program.** Drop a `.zip`, a folder, or loose `.py` files onto
   the page, or use the file picker. A zipped folder loses its top-level
   directory. `__MACOSX`, `.git`, `__pycache__` and `.DS_Store` entries are
   ignored. Stored and deflate members are supported; zip64 is not.
2. **Pick the entry.** `main.py` wins, then `__main__.py`, `game.py`,
   `run.py`, `app.py`, `start.py`, then a lone root-level script. The bar
   lets you change it. The `args` field becomes `sys.argv[1:]`.
3. **Run.** A Worker installs the package into a private OPFS BlockFS image
   (once per package sha, verified against `index.json`), seeds the program
   under `/game`, and calls host.js `runModule` with the interpreter as
   `argv[0]`. The interpreter finds its stdlib by the same argv0 landmark
   walk it uses under gucOS (`docs/CPYTHON.md` §5.2), so no environment
   variable names a prefix.

Standard output and error go to the terminal. Standard input is the
terminal too: a cooked line discipline on the page side, raw mode when the
program asks for it through `termios`. `Ctrl-D` sends EOF, `Ctrl-C` stops
the run (there are no signals without a kernel).

## Test seam

`window.__pyplay` exposes `state`, `lastExit`, `events` (status messages,
which name a download when one happens), `output`, `runFiles(files, entry)`
and `stop()`. `?run=<same-origin zip url>` autoloads and runs a zip;
`&autorun=0` only loads it. `tests/browser/os-pyplay.mjs` drives all of it.

## Layout

| file | role |
|---|---|
| `index.html` | shell: bar, drop zone, canvas, xterm |
| `pyplay.js` | main thread: zip/folder loading, entry pick, stdin ring, worker orchestration, SDL input forwarding |
| `pyplay-worker.js` | worker: package install into BlockFS v4, program seeding, `runModule` |

The page loads `host.js` unmodified on both threads: `SDL_WEB` and
`createAudioReceiver` on the main thread, `BLOCK_FS` and `runModule` in the
worker. The image is a **v4** volume on purpose: `BLOCK_FS.init` formats the
legacy v3 layout, which has no `/dev` nodes, and this CPython build seeds
hash randomization from `/dev/urandom`.

## Status

Text-mode Python programs run today. SDL programs from Python need pygame,
which is not built yet; the trajectory is `docs/CPYTHON.md` §8. The SDL
plumbing on this page (canvas hand-off, input forwarding, shared audio
ring) is already the emitted-page shape so that work lands on top, not
beside.
