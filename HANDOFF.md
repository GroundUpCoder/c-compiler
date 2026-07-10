# Handoff — start of thread (updated 2026-07-10; 0070 desktop-default-tab closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0070 (Desktop as the default tab) is CLOSED** — dev log
`logs/2026-07-10/0070-desktop-default-tab.md`, details in
`todos/done/0070-desktop-default-tab.md`. The load-bearing facts:

- Boot still streams on VT1; os.html's `ready` handler auto-switches to
  VT2 **unless the user picked a VT during boot** (`vtTouched`, set by
  `userSetVt` — tab clicks, the Ctrl+Alt hotkeys, AND the `__osVtSwitch`
  agent probe all mark it). `boot-error`/`halt` still force VT1.
- **Browser-test consequence (the new gotcha, see below): after `ready`
  the page sits on VT2.** Any new os-*.mjs test must `setVt(1)` before
  its first shell keystroke; `waitOut`/`__osOut` probes are VT-agnostic.
- os.html is runtime-only (not a bake input) — the change needed no
  `image.json` version bump. Image version stays **v43**.
- Sweep after the change: **15/15 in 73.8s**. os-vt.mjs owns the new
  semantics (incl. a synthetic `boot-error` leg that drives
  `kernel.onmessage` directly); os-screen's opening legs are re-baselined
  (the ready auto-switch IS the first VT2 entry, so the 800x500 boot
  default is already re-moded when the test looks).

**Next in queue**: run `node todos/queue.js list` — 0072 openwith leads,
then 0075 sameboy (after 0072), 0063 aero.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`): quake lock on
click, ESC unlock, click re-lock, VT-switch release.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0070): browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`. The
  screen syncs to the viewport pane at ready (auto VT2 entry), so no test
  can see the 800x500 boot canvas after a healthy boot anymore.
- **Don't edit bake inputs while a suite runs**: the 0082 gate makes any
  compiler.js/os/-tree/vendor edit invalidate the fixture — files started
  after the edit will re-bake privately (correct, but slow/contended).
  Land the edit, re-run; or run mkimage first.
- **New-runner habits**: after an interrupted/failed suite run, look at
  `build/test-*/summary.json` + the per-file `.log` before rerunning;
  `--resume` skips prior passes. Don't crank `-j` past the default on a
  loaded box — the e2e `sleep N` sync sites flake under contention until
  0083 lands.
- **Sweep is serial by design** (0045 boot lock + contention); os-sweep
  rejects `-j`. Keep it that way.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('cairodemo' is in both lists now).
- **Editing seeded sources or coreutils.json/bin.json/lib.json**: the
  headless/test/serve paths detect it by mtime (0082) — no manual mkimage
  needed. Bump `image.json` `version` (now 43) anyway when an interactive
  browser tab must pick the change up (OPFS re-fetch is version-gated
  only). A LIBC change in compiler.js counts as an input; so do
  freetype/cairo lib.json changes (term/cairodemo relink).
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
tests as acceptance); 0081's calls (ONE shared suite engine, kernel `-j4`,
sweep serial, run-unit.js untouched); 0082's calls (input-freshness by
mtime scan, fixture = `os/os-system.img` itself, `version > manifest`
blobs kept, test_os_boot stays the real-bake test); 0070's call: boot
STAYS on VT1 until `ready` (don't seed `data-vt=2` — the boot log and the
boot-error escape hatch need VT1), auto-switch only on a healthy ready,
user choice during boot wins.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0072 openwith, 0075 sameboy, 0063 aero, 0079 dep-dedup, or
0064 WM sweep round 3 (the pointer-lock human check is owed)."
