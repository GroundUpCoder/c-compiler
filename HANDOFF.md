# Handoff — start of thread (updated 2026-07-10; 0081 test-infra closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0081 (testing-infrastructure overhaul) is CLOSED** — dev log
`logs/2026-07-10/test-infra-overhaul.md`, findings + measurements in
`todos/done/0081-test-infra-overhaul.md`. The load-bearing facts:

- **One engine, three runners**: `tests/lib/suite-runner.js` now powers
  `tests/kernel/run.js` (parallel, default `-j4`), `tests/browser/
  os-sweep.mjs` (the 15-file sweep as ONE serial command; discovers
  `os-*.mjs` so new tests auto-join), and `tests/blockfs/run.js`.
  All three: `--filter`, `--resume`, `--fail-fast`, `--timeout`, per-file
  logs + an incrementally checkpointed `summary.json` under
  `build/test-{kernel,browser,blockfs}/` — an interrupted run keeps its
  partial verdict, and timeouts kill the whole process group (no more
  orphaned boot.js/Chromium children). `tests/run-unit.js` (per-test
  workers) is untouched and remains the fine-grained template.
- **Measured**: kernel suite = 1354s serial, of which 16 boot.js e2e
  files carry 97% — it's all image BAKE cost. At `-j4`: **393s, 40/40
  green**, zero parallel flakes. Browser sweep with a fresh prebaked
  `os/os-system.img` on disk: **~70s for 15/15** (the "1–2 min per
  file" lore was the in-worker bake when no prebake exists).
- **Verification debt from 0061 is PAID**: full kernel suite 40/40,
  full 15-file sweep 15/15 (os-shell.mjs first), blockfs 15/15 — all
  this session, on image v43.

**Follow-ups created at the close** (in the queue): `0082` prebaked-image
fixture for boot.js e2e — the remaining wall-clock multiplier (~2x more),
including input-freshness gating for BOTH prebake paths (a same-version
blob baked before an uncommitted compiler.js edit must never be silently
reused — today the browser path WOULD silently fetch one; run
`node tools/mkimage.js` before trusting a sweep if compiler.js/os/ changed
without a version bump); `0083` event-based waits (the ~205 counted
`sleep N`/fixed-delay sites — the flake class; slotted before 0064 so WM
sweep round 3 benefits); `0084` unified entry point + diff-aware suite
selection.

**Next in queue**: run `node todos/queue.js list` — 0082 leads, then
0070 desktop-default-tab, 0072 openwith.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`): quake lock on
click, ESC unlock, click re-lock, VT-switch release. (The automated sweep
is now cheap enough to run casually; the human check still isn't in it.)

## Gotchas carried forward (trimmed to the live ones)

- **New-runner habits**: after an interrupted/failed suite run, look at
  `build/test-*/summary.json` + the per-file `.log` before rerunning;
  `--resume` skips prior passes. Don't crank `-j` past the default on a
  loaded box — the e2e `sleep N` sync sites flake under contention
  until 0083 lands.
- **Sweep is serial by design** (0045 boot lock + contention); os-sweep
  rejects `-j`. Keep it that way.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('cairodemo' is in both lists now).
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 43) — rebake with
  `node tools/mkimage.js`; boot.js `--fresh-system` forces headless.
  A LIBC change in compiler.js counts. A freetype/cairo lib.json change
  counts too (term/cairodemo relink). Until 0082's freshness gate, also
  re-run mkimage so the browser sweep's prebake isn't stale.
- **Cairo/pixman config is hand-written** (`vendor/cairo/config.h` +
  `src/cairo-features.h`; pixman via two -D flags in lib.json). When
  adding cairo features (0080), extend BOTH headers and lib.json, and
  record patches in the README table. Testsuite diff policy: tol 3,
  hard cap 16 — refs are from a different pixman minor; don't tighten.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — the internal
  git-mv can stage a pre-edit blob (re-`git add` the done file).
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording — moves if the message changes.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop" asserts;
  desktop teal == compositor teal; derive geometry from `__osScreen`;
  a SECOND page needs a fresh context/browser.
- Concurrent sessions may be active in this repo: check `git status`
  before staging and stage ONLY your own files.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or project-include-path resolved.
- For the long tail (WRES v2, wmctl click one-arg=label, clipboard file,
  EM_GETHANDLE, argv0, AUDIO_GAIN, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, `ls /`
  goldens incl. proc, 0040 image pairing, MUST-MATCH block list): see
  `todos/done/0048`'s Status, `logs/2026-07-10/0048-closeout.md`, and the
  CLAUDE.md sections — they are the durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0069's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0061's calls (cairo-not-a-2D-invention, image-backend-only, upstream
tests as acceptance); 0081's calls: file-granular parallelism via ONE
shared engine (not a per-suite rewrite), kernel default `-j4`, sweep
serial by design, run-unit.js's worker model untouched.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0082 boot-fixture (continues the test-infra work, ~2x more
wall-clock), 0070 desktop-default-tab, 0072 openwith, 0079 dep-dedup,
0080 cairo PDF surfaces, or 0064 WM sweep round 3 (the pointer-lock human
check is owed)."
