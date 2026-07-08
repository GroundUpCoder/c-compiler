# Handoff — start of thread (updated 2026-07-08, after 0038 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0038 (WM known-issues fixes: kernel z layers) landed 2026-07-08** —
dev log `logs/2026-07-08/wm-z-layers.md`, decision recorded in
`todos/WM.md` "Implementation status — z layers". Per-surface z layer
-1/0/+1 (WMP SET_LAYER 0x1A / `wmSetLayer` / `wmctl layer`; record
word 11 = ex-reserved; `wmctl list` FLAGS grow a T/B char), every
z-order op stable-sort-normalized within its layer; wm.c pins
taskbar+Start menu → +1, desktop → -1. The taskbar is always-on-top
and nothing sinks under the desktop; no-WM fallback untouched. Image
is **v27**. Test-first: failing legs committed as a17f7e5, fix
separate. All suites green at the landing: unit 697✓, blockfs✓,
kernel✓ (new legs in test_wm_policy + test_wm_service_e2e), full
serial browser sweep✓ (os-wm gained the drag-onto-strip leg; ran 3×
clean after one non-reproducing first-run boot-phase flake).

**0040 (read-only system image) landed earlier the same day** — dev log
`logs/2026-07-08/read-only-system-image.md`, decisions in
`todos/DISK-IMAGE.md`: writable root at `/` + sealed RO blob at `/usr`,
`tools/mkimage.js` bakes `os/os-system.img` (gitignored).

## The queue (todos/README.md is authoritative)

Next up: `0039` WM sweep round 2 (MUST include the pointer-lock
HUMAN check round 1 skipped + re-verifying 0038 under storm — try
`wmctl layer`/`raise`/`lower` combinations against the layer
invariant), then `0034` coreutils batch 2, `0035` spawn-capable
applets, `0036` seed the REPLs, `0037` wasm module cache (its cache
key exists: the blob's `/usr/share/os-release` VERSION_ID), the
WebGPU app port (WEBGPU.md).
(`0006` threads+atomics stays deferred indefinitely.)

## Gotchas carried forward

- **0040 layout in tests**: `ls /` is now `bin dev etc root run tmp usr
  var` (bin is a symlink); headless images pair as `foo-system.img` +
  `foo-root.img` (`os.img` → `os-root.img`); OPFS names are
  `os-system.v5.img`/`os-root.v5.img`. Screenshot reads out of the raw
  image use FULL paths now (`/root/d.ppm` on the root volume — no prefix
  strip).
- **Editing seeded sources (wm.c, term.c, cc.c…) still requires bumping
  `os/image.json` `version`** — a same-version blob is reused, so your
  edit won't reach the OS. A stale prebaked `os/os-system.img` on disk is
  harmless (version-gated) but rebake it (`node tools/mkimage.js`) to
  keep browser boots fast.
- EROFS guards in host.js run AFTER the path walk — keep that ordering
  if touching mutating ops (escaping `/usr/local` paths depend on it).
- Aliased two-path ops (`mv` within `/usr/local`) are EXDEV by MountFS
  lazy resolution — documented in DISK-IMAGE.md, busybox copes.
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; the desktop layer's teal equals the compositor background teal.
  After a VT switch, SETTLE before clicking furniture (the entry resize
  re-lays taskbar/desktop — the os-shell override leg shows the pattern).
- hush `kill` is cooperative SIGTERM: after killing the wm, barrier on
  its surfaces vanishing before asserting no-WM behavior.
- Taskbar geometry: button 0 spans x 56..160 at ≤8 windows; wm.c wins[]
  is launch order; work area is `scr_w x (scr_h - BAR_H - TITLE_H)` at
  (0, TITLE_H) with wm.c's TITLE_H=28 (kernel's is 24).
- Browser-test rules: derive geometry from `__osScreen`/live canvas
  rect, wm placement is async, keep the sweep serial. Headless applet
  note: `cut` is NOT seeded — extract wmctl fields with `sed`.
- The IDE's clangd flags os/*.c and vendor SDL sources (SDL.h not
  found etc.) — noise; those headers are compiler.js built-ins.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP incl. CYCLE/EV_CYCLE
  + SET_LAYER; 80-byte record, word 11 = layer) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring
  layout kernel.js (SH_*/IR_*) ↔ host.js (WMSH_*/WMIR_*); ring event
  numbers (WMEV) ↔ <SDL3> event values in compiler.js ↔ host.js WMEV_*;
  audio ring layout kernel.js (AU_*) ↔ host.js; SDL audio format words ↔
  <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js. NEW: the
  sealed-blob superblock fields (SB_SEALED_BIT/SB_SEAL_HASH) host.js ↔
  tests/blockfs/fsck_v4.js.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0033's decisions, DISK-IMAGE.md's settled layout
  (incl. the 0040 in-item decisions: os-release version file,
  fresh-root-only user seed, `<` staleness, no live-seed flag).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0039 WM sweep round 2 (incl. the pointer-lock human check),
0034 coreutils batch 2, or something else."
