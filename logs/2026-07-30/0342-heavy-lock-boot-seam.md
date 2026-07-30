# todos/0342 — the heavy lock moves to the boot seam (closes todos/0303)

The heavy-test host lock used to live in exactly two places: the kernel
suite runner and the browser sweep runner. Every documented single-file
invocation — `node tests/kernel/<e2e>.js`, a bare `node os/boot.js`, a
hand-run `os-*.mjs` — booted a full OS with no lock. The 2026-07-25 OOM
guard therefore guarded an entry-point list, not the resource.

## What changed

- `tests/lib/heavy-lock.js`: the acquire/refuse loop moved into one shared
  core (`contendForLock`). Ownership now exports `CC_HEAVY_LOCK_PID`. The
  new `joinHeavyLock({name, waitMs})` runs at the boot seams. It joins
  re-entrantly ONLY when the marker pid is alive AND equals the recorded
  holder. `waitMs` turns the refusal into a loud poll (a status line every
  30 s) with an optional deadline.
- `os/boot.js`: joins the lock after argument validation and before any
  store, bake, or mount work. New flag `--wait-lock[=SECS]`. This is the
  seam for shape 1 (a `node os/boot.js` process, 8 entry paths, re-derived
  at implementation time; `drive.js` covers only 1 of the 8).
- `tests/browser/lib/os-harness.mjs`: joins once, at the first of
  `startServer`/`launchBrowser`. This is the seam for shape 2 (an os.html
  boot in a Chromium; all 42 sweep files plus the tools funnel through it).
- `tests/kernel/lib/drive.js`: propagates a child's refusal (exit 3 + the
  `[heavy-lock]` marker) as its own exit 3, so a single-file e2e names the
  holder with zero per-file edits.
- `tests/kernel/test_heavylock_e2e.js`: nine control legs under a private
  `TMPDIR` lock scope (24 checks). Leg 2 is the RED control. Leg 3 is the
  nested re-entrancy proof. Legs 8/9 exercise `--wait-lock` (both added
  past the design table — the acceptance names the flag).
- `CLAUDE.md` + the heavy-lock.js header state the new coverage. L65 is
  retired from the register in the same commit.

## Decisions and gotchas

- **Leg 7's vehicle is `os-boots.mjs`, not the design table's
  `os-minimal.mjs`.** os-minimal runs `tools/mkpkg.js` before it reaches
  the harness; a refusal control must not start a package build (0388: the
  prune deletes payload bytes, and `.mkpkg-lock` refuses concurrent builds,
  which makes the leg racy under `--repeat`). os-boots hits `startServer`
  first, so the silent `[serve]` tap proves "refused before serve.js".
- **A refusal test cannot free the lock from its own timer.** `spawnSync`
  blocks the event loop, so a `setTimeout` unlock never fires. Leg 9
  spawns a helper process to free the lock. (First manual probe of the
  wait path failed exactly this way.)
- **Exit 3 alone is not the lock signal.** Init can exit 3 legitimately
  (`sh -c 'exit 3'`). Every consumer matches exit 3 AND `[heavy-lock]`.
- The recorded uncoverable exclusion: a human browser tab against a dev
  `serve.js`. No repo process can lock a human's browser; the 0045 Web
  Lock guards image coherence there, not RAM.
- The 0303 light-suite ruling stands as written (permission, not gap): the
  guard now rides the boot itself, so the suite list in the header comment
  stopped being load-bearing.
