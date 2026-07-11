# Handoff — start of thread (updated 2026-07-12; 0146 shared test harnesses landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0146 (extract shared test harnesses) is DONE and committed.** Two new
modules remove the per-test copy-paste that made 0083 (event-wait) hard to
land:

- **`tests/kernel/lib/drive.js`** — `driveBoot(script, opts)` is the single
  headless boot seam: `mkdtemp`+`os.img` (or reuse `opts.image`), spawn
  `node os/boot.js --image=<img> --quiet [...args]`, pipe the script on stdin,
  return the `spawnSync` result (throws on spawn error → folds in the
  `if(r.error)throw`). `freshImage(prefix)`/`section(out,name)` alongside.
  **27 canonical single-shot e2es converted; full kernel suite 58/58 green.**
- **`tests/browser/lib/os-harness.mjs`** — `startServer`/`waitForServer`/
  `launchBrowser` (WebGPU flags; **playwright imported lazily** so pure helpers
  load in plain Node)/`makeCheck`/`osHelpers(page)` (`setVt`/`sample`/`near`/
  `waitPixel`/`waitOut`/`waitScreen`)/`waitFor`/`openOsSession`. **All 23
  `os-*.mjs` converted byte-faithfully**; pure helpers unit-tested
  (`tests/browser/lib/test-harness.js`, green).

0083 now has the two seams to add `wmctl wait` (in `driveBoot`) and the browser
`waitFor` (in the harness) once, instead of per-file.

## Tests / verification

- **Kernel: full suite 58 passed, 0 failed** (`node tests/kernel/run.js`, 384s)
  — the verifiable half, proven end-to-end.
- **Browser: static-verified only.** Every `os-*.mjs` + the harness
  `node --check`s clean; no leftover `playwright`/`spawn`/`chromium.launch`/
  bare `failures`; harness pure-helper unit test green. **The browser sweep was
  NOT run — Playwright is not installed in this clone** (browsers cached, package
  absent; the browser tier has always been operator-owed). Byte-faithfulness was
  the conversion rule: files whose helpers diverge (`near` tol 12; old-form
  `sample`/`waitPixel`; width-only or `w>800`-less screen waits; 250 ms poll;
  extra-`tol` `waitPixel`) were **left inline** — only exact-match shapes were
  pulled into `osHelpers`. Runtime confirmation is filed as **0153**.

Dev log: `logs/2026-07-12/0146-shared-test-harnesses.md`. Item at
`todos/done/0146-test-harness-extract.md`.

## Follow-up filed

- **0153** (P1) — run `node tests/browser/os-sweep.mjs` under Playwright to
  confirm the 0146 conversion changed no observable behaviour (goldens
  unchanged). Overlaps 0064's WM sweep but makes the 0146-specific check
  explicit rather than buried in 0064's WM scope.

## Gotchas carried forward (trimmed to the live ones)

- **Concurrent sessions exist: stage ONLY your own files**, and re-check HEAD
  before committing — it can advance mid-session. Reconcile shared files
  (`queue.json`, `image.json`) against the *current* HEAD.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (verified this session: the git-mv staged
  the "Status: open" blob; re-adding staged the "DONE" one).
- **Bump `image.json` `version` when you edit a seeded bake input** (`os/*.c/.h/
  .json/.rc`, `compiler.js`, `host.js`, `vendor/`): a persistent browser OPFS
  image only re-fetches on a version bump. Still **v72** (0146 touched only
  `tests/` — no bake-content inputs).
- **Playwright is not installed here.** `node tests/browser/*` (any os-*.mjs or
  os-sweep) needs a separate install; the browsers are cached under
  `~/Library/Caches/ms-playwright`. The kernel suite and `node --check` run fine.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. After 0146 the head is
the **0083/0084 pair** (0083 was soft-`after` 0146 — now unblocked; it lands
`wmctl wait`/browser `waitFor` in the new harness seams), then **0147**,
**0079/0080**, **0052/0053**, **0064** (WM browser sweep round 3 — the standing
operator debt), and the 0133–0139 notepad-EDIT set. No open P0s.

## Operator-owed (browser, Playwright required)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check + the
  0094–0151 legs incl. the unrun `os-paint.mjs`).
- **0152** — a `--clang` browser boot confirming the served overlay blob renders
  the clang apps in real Chromium.
- **0153** (new) — run `os-sweep.mjs` to validate the 0146 harness conversion.

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU). `node tests/browser/os-sweep.mjs` runs the whole
sweep serially.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0152's recorded decisions (see todos/done/). **0146's
call: `driveBoot` is the single-shot boot seam only — async paced-tty sessions
(`cp.spawn --tty-out`) stay inline; and `osHelpers` extracts ONLY the
exact-match helper shapes, leaving tolerance/timing-divergent inline helpers
untouched so goldens can't shift.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0146 shared test harnesses
just landed; no open P0s, head is the 0083/0084 pair, now unblocked). Browser
sweep validation of the 0146 refactor is owed to the operator as 0153
(Playwright not installed here)."
