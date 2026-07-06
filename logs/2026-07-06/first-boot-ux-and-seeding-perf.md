# First-boot UX + seeding performance (post-0005 fresh-pull findings)

Two issues the user hit following the README on a fresh `git pull` —
both invisible to the automated loop, both now fixed (`31b190c`,
`5f00e19`). Recording the lessons, not just the fixes.

## 1. "Not found" on the documented path (`31b190c`)

Two footguns stacked: `node serve.js` without an argument serves
`./build` (a directory that doesn't exist in a fresh checkout), and even
`node serve.js .` prints a bare `http://localhost:PORT` — which 404s,
because the repo root has no index.html; the OS lives at `/os/os.html`.

Fix: serve.js prints the full `/os/os.html` URL whenever the served tree
contains it.

**Lesson**: the automated browser test launches serve.js itself and
navigates *directly* to the page — it never walks the
fresh-pull-follow-the-README path a human takes. The first-run path needs
either a test of its own or at least a manual walk after landing anything
entry-point-shaped.

## 2. First browser boot took ~7.5s; only ~1.5s of it was compiling (`5f00e19`)

Measured, not guessed:

| | time | HTTP requests |
|---|---|---|
| Headless fresh seed (Node) | 1.75s | — |
| Browser fresh seed, before | 7.5s | **18,722** |
| Browser fresh seed, after | **2.3s** | 318 |

Seeding compiles the userland (hush ≈ 40 TUs + libc, plus cc/psh/cat/ls)
with the in-browser compiler — that's the deliberate no-build-step
design, and the image is the cache (warm boots: ~60ms headless). The
slowness was NOT the compiler: the kernel worker reads sources over
synchronous XHR, and include resolution probes several directories per
`#include` per TU — every probe, hit or 404, a blocking round trip, and
the same headers re-probed by every TU. One `Map` memoizing reads
INCLUDING misses (safe: the tree can't change mid-seed) collapsed it.

**Lessons**:
- When a phase is slow, measure the phase's *substrate*, not just its
  work: the compile was innocent; 18.7k tiny blocking I/Os were the cost.
  (`page.on('request')` count + timestamped boot-log marks did it in one
  run.)
- Any future sync-reader bridge (the seeding pattern will recur for 0010
  coreutils) should be born memoized.
- If first-boot latency ever matters beyond the dev loop, the recorded
  answer is `tools/mkimage.js` (pre-baked image blob, OS.md "Reference
  build") — download instead of build.
