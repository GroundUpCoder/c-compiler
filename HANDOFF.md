# Handoff — start of thread (updated 2026-07-11; 0118 image overlays closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0118 (optional opt-in image overlays — the consumer) is CLOSED.** gucOS can
now fold a sibling-published, prebuilt `overlay@1` manifest into the read-only
system image at bake time, flag-gated and off by default. Dev log
`logs/2026-07-11/0118-image-overlays.md`; item at
`todos/done/0118-image-overlays-opt-in.md`. **Not yet committed** — commit +
push are the next action (see below).

One breath: **`node tools/mkimage.js --overlay=clang-apps` cross-folds real
C/C++/SDL apps that this repo's `compiler.js` can't build.** The sibling
`~/git/clang-simplified` (cc2wasm) publishes `out-image/overlay.json` + hashed
binaries + provenance; this repo is the CONSUMER only — reads the JSON,
**recomputes + verifies sha256/size**, plants bytes, records provenance. Off by
default: a plain bake is inert (base os-release unchanged, no overlay artifacts).

- `os/image.json` — new top-level `overlays[]` (the `clang-apps` entry). **Version
  stayed 65** (the key is inert; base bake byte-content-identical).
- `tools/mkimage.js` + `os/boot.js` — `--overlay=<id>` (repeatable),
  `--overlays=all`, `--require-clean-overlays`. Unknown id → **exit 2 before any
  bake**. boot.js forces a re-bake when overlays are requested.
- `os/os-common.js` — the ONE impl: `loadOverlays` (verify BEFORE the seed —
  fails fast), `plantOverlays` (placement/conflict rules against the seeded base,
  then plant + provenance at `/usr/share/overlays/<id>.json`), `nodeOverlayIo`
  (fs/path/crypto injection so os-common stays environment-neutral). Wired into
  `bakeSystemImage`; identity stamped via os-release `OVERLAYS=` + a
  `/usr/share/os-release.overlays` companion.

**Verified end-to-end against the REAL sibling artifact** (it had already landed,
`repo.dirty:true`): `--overlay=clang-apps` planted 7 files (its cc2wasm doom
**overrides** the base doom, plus stl4/sdldemo/DOOM1.WAD/.desktop), warned loudly
about the dirty tree, sealed. Booting that image and running the cc2wasm-built
**console** C++ demo `/usr/bin/stl4` printed correct STL output and exited 0.

**Verified**: `tests/kernel/test_overlays.js` (unit-scale bake, all fatal paths,
base inertness — registered in `tests/kernel/run.js`) ALL PASS;
`tests/kernel/test_os_boot.js` PASS (base bake path unchanged).

**Follow-ups filed** (both named in 0118's Status): **0120** (P2) — drive the
*windowed* overlaid DOOM via `wmctl shot` (browser + e2e; no Playwright here).
**0121** (P3) — make image bakes blob-deterministic (the baker stamps wall-clock
inode mtimes, so Acceptance (a)'s literal "byte-identical" is unmet; 0118 asserts
inertness instead).

## To commit (this thread's work, uncommitted in the tree)

`os/boot.js`, `os/image.json`, `os/os-common.js`, `tools/mkimage.js`,
`tests/kernel/run.js`, `tests/kernel/test_overlays.js` (new),
`todos/queue.json` (0118 dropped), the 0118 done-file move + Status edit
(**already re-staged** — `queue.js done` had staged the pre-edit blob),
`todos/0120-*.md` (new), `logs/2026-07-11/0118-image-overlays.md` (new).
Then push to main (user asked to commit + push if testing looked good — it did).

## Gotchas carried forward (trimmed to the live ones)

- **0118: the bake is NOT byte-deterministic** — BlockFS stamps inode mtimes
  from the wall clock, so two identical base bakes differ (~24 bytes, plus the
  seal). So "byte-identical to current output" is only true at the *content*
  level (os-release string, file set), not the raw blob — assert inertness that
  way, never a whole-blob compare.
- **0118: `--quiet` silences the dirty-overlay WARNING** (same `log` channel);
  the durable record survives in `os-release.overlays` (`dirty:true`). Accepted
  trade — don't thread a separate stderr channel through neutral os-common.
- **0118: an overlay `bin` whose target is a base path needs `"override": true`**
  (the sibling's cc2wasm doom does exactly this to replace the base doom). Two
  enabled overlays hitting one path is fatal.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again. (Hit + fixed this session.) **Concurrent
  sessions exist: stage ONLY your own files.**
- **Don't edit bake inputs while a suite runs** (0082): `.md`/`tests/` are NOT
  inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`, `vendor/` are. Bump
  `image.json` `version` (now **65**) when an interactive browser tab must pick
  up seeded-source edits (an inert non-baked key like `overlays[]` doesn't need
  a bump — content is unchanged).
- **New-runner habits**: check `build/test-*/summary.json` + per-file logs after
  an interrupted run; `--resume` picks up. The kernel runner is a MANIFEST — new
  test files must be added to `tests` in run.js (did so for test_overlays.js).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium with
  `--enable-unsafe-webgpu --enable-features=Vulkan`.

## Next in queue

`node todos/queue.js list` — after 0118: **0106–0107** (desktop-icon details/
multi-select tail), **0112**, then the P1 body (0088, 0079/0080, 0052/0053, …).
This thread's follow-ups **0120** (P2, pos 28) + **0121** (P3, pos 30) trail it.
The 0064 WM sweep round 3
still owes the operator the pointer-lock human check, the 0094 sound listen, the
0095 snap feel, the 0096 saver eyeball, and the 0101–0105 browser legs.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0105's recorded
decisions (see todos/done/); DISK-IMAGE.md's settled layout; **0118's calls
(prebuilt-only — never trigger the sibling build; flag-gated + off by default;
loud FATAL on missing/bad-hash, WARN on dirty; verify-before-plant;
`overlay@1` is the ONE frozen cross-repo contract — if it must change, both
repos bump to `overlay@2` together; image identity is additive via os-release
OVERLAYS=/companion, `bakedVersion` stays authoritative for the base)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0118 image overlays just
landed — commit + push it first if not already done; then 0106–0107 desktop-icon
details/multi-select, 0112; 0120 is 0118's windowed-DOOM smoke-leg follow-up).
0064 WM sweep round 3 still owes the operator the pointer-lock check and the
0094/0095/0096/0101–0105 browser legs."
