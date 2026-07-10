# Handoff — start of thread (updated 2026-07-10; 0061 Cairo closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0061 (Cairo) is CLOSED** — cairo 1.18.4 + pixman 0.42.2 vendored and
`/bin/cairodemo` seeded (image **v43**), dev log
`logs/2026-07-10/cairo-2d.md`. The load-bearing facts:

- **Two compiler fixes came out of it** (both test-first, both general):
  the assignment setjmp forms (`if ((v = setjmp(buf)))` — value captured,
  0→1 coerced per C11; `tests/unit/stdlib/setjmp_assign`) and C11 "other"
  pp-tokens (`@ $ \`` lex as deferred tokens, diagnosed only if they
  survive preprocessing; `tests/unit/conformance/pp_skipped_other_pptoken`).
  The whole cairo+pixman vendor tree carries ONE one-line patch.
- **Acceptance = the corpus as oracle**: `vendor/cairo/testsuite/` runs
  14 UNMODIFIED upstream test programs against upstream reference PNGs —
  **9 pixel-EXACT**, rest within worst channel diff 9/255 (AA jitter).
  Growing the subset is cheap (one .c + one ref + one runner-table row).
- Tests: `tests/run.py --types cairo` (smoke + selftest + upstream suite),
  `tests/kernel/test_cairo_e2e.js` (in the kernel suite),
  `tests/browser/os-cairo.mjs` (in the sweep, now **15** files).
- cairodemo is the first RESIZABLE pixel-probed app: `wmctl resize` →
  the VECTOR scene re-renders crisp; e2e probes anchors at 1.25x coords.
- freetype's lib.json grew `ftmm.c`/`ftsynth.c` (cairo-ft needs them) —
  term relinks, image rebaked.

**Follow-ups created at the close** (in the queue): `0079` project-file
diamond-dep dedup (duplicate-symbol link errors; cairo's lib.json omits
its honest zlib dep until then), `0080` cairo PDF/SVG output surfaces
(the subsetting machinery already compiles — near-free printing), and
`0081` **testing-infrastructure overhaul** (user-requested, queued near
the top: the kernel suite is a ~20-min serial monolith of full OS boots,
the browser sweep is 15 manual serial Chromium runs, sync is sleep-based
— survey holistically, then spawn concrete sub-items).

**Verification state at the 0061 close (be honest with the next round)**:
unit suite 701 green; `run.py --types cairo` + `projects` green; targeted
kernel tests green (cairo_e2e 21/21, wm_service, os_boot, term); 27 of 41
kernel-suite files green across two partial runs (both runs died with
session teardown — exactly the 0081 complaint; no failures seen). The
FULL serial kernel suite and the full 15-file browser sweep did NOT
complete this session: os-cairo.mjs passed, but os-shell.mjs was NOT
re-run after its MENU_ENTRIES gained 'cairodemo'. **Owed at the next
sweep round (0064) or first 0081 milestone: full kernel suite + 15/15
sweep, os-shell.mjs first.**

**Concurrent sessions were active this thread**: 0075 (sameboy) and
0076–0078 (desktop polish) landed from other sessions while 0061 was in
flight — both landings were clean, but keep checking `git status` before
staging and stage ONLY your own files (the 758dd6e cautionary tale in
`todos/done/0048`'s logs still applies).

**Next in queue**: run `node todos/queue.js list` (0070 desktop-default-
tab and 0072 openwith lead; 0062 zero-copy present is deferred).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`): quake lock on
click, ESC unlock, click re-lock, VT-switch release.

## Gotchas carried forward (trimmed to the live ones)

- **Cairo/pixman config is hand-written**: `vendor/cairo/config.h` +
  `src/cairo-features.h` (single-threaded: CAIRO_NO_MUTEX + no-op-mutex
  atomic fallback), pixman configured by two -D flags in lib.json. When
  adding cairo features (0080), extend BOTH the features header and
  lib.json, and record any patch in the README's patch table.
- **cairo testsuite diff policy** (`testsuite/runner.c`): tol 3, hard cap
  16, bounded outliers — refs come from a different pixman minor, so
  don't tighten to exact; real errors are high-contrast and fail anyway.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('cairodemo' is in both lists now).
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 43) — rebake with
  `node tools/mkimage.js`; boot.js `--fresh-system` forces headless.
  A LIBC change in compiler.js counts. A freetype/cairo lib.json change
  counts too (term/cairodemo relink).
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
  keep the sweep serial; a SECOND page needs a fresh context/browser.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially after
  touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths,
  or anything that rebakes every binary. (Last FULL sweep: 2026-07-10 at
  the 0074 close, 14/14 — 0061 ran only os-cairo.mjs; the 15-file sweep
  is owed, see above.)
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
0061's calls: cairo-not-a-2D-invention, image-backend-only (0080 owns
PDF/SVG), cairo-webgpu backend declined until a GPU-2D app measurably
needs it, upstream-tests-as-acceptance.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0070 desktop-default-tab, 0072 openwith, 0079 dep-dedup, 0080
cairo PDF surfaces, 0064 WM sweep round 3 (the pointer-lock human check
is owed), or something else."
