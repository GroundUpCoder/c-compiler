# Handoff — start of thread (updated 2026-07-12; 0088 puNES closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0088 (puNES NES/Famicom core) is CLOSED and COMMITTED.** `/bin/punes` is a
real cycle-accurate NES emulator — puNES (`punesemu/puNES` @ `2ed5b1b`)'s C core
with an SDL3 frontend. It's the fourth emulator leg (after 0075 SameBoy GB/GBC,
0112 mGBA GBA, and the lighter `/bin/gameboy`) and the accuracy tier — 6502/
2C02/2A03, second only to Mesen. `.nes` → `/bin/punes`, Games-menu entry, image
**v70**. Dev log `logs/2026-07-12/0088-punes-nes-core.md`; item at
`todos/done/0088-punes-emulator.md`; port lives in `vendor/punes/`
(`README.md` has the license split + excluded-file list + seam description).

One breath: puNES core is **plain C** (only the Qt shell + a few exotic
expansion-audio DSP files are C++). Vendored **verbatim — no core patches**. The
frontend is **fresh SDL3 glue** (`frontend/`) against today's `gui_*`/`gfx_*`/
`snd_*` seam, NOT the recovered pre-Qt SDL frontend the item suggested (too
drifted). `main.c` hand-runs power-on (`memmap_init`→`ppu_init`→`emu_turn_on`),
one frame per host anim-frame (`emu_frame`), reads the PPU palette-index buffer
(`nes[0].p.ppu_screen.last_completed_wr`) straight into an RGB-mapped surface;
`pn_orphan.c` supplies the globals upstream only defines in the excluded Qt
`main.c` (the link-stage wall). Excluded: `src/c++/` + the C++ DSP mappers
(crc/pic16c5x reimplemented in C), zip/7z load, NSF/recording/threads. Bare
`punes` runs a built-in NROM test ROM (hand-assembled 6502 → solid palette-$21
blue frame) as the headless pixel-test target — same solid-fill shape as mgba's
MODE 3 red.

**This port drove ONE compiler.js change** (general, unit-suite-clean):
`__attribute__` trailing a **parameter declarator** — `f(int x
__attribute__((unused)))` — now parses (consumed + ignored; never affects the
param ABI type). Regression test `tests/unit/conformance/pp_attr_param_declarator/`.
That was the *only* gap the 104-KLOC core surfaced; the rest was integration.

**Verified** (all PASS): `node tests/kernel/test_punes_e2e.js` (7/7 — bake+boot,
window "puNES" 512×480, `wmctl shot` solid palette-$21 blue frame, `.nes`→punes);
`node tests/run-unit.js` (708/0/3); `node todos/queue.js check` passes; the
e2e's image bake compiled the full app set unbroken.

## Concurrent-session note

Another session committed **during** this work: `fa79315` (mgba opaque-alpha
fb→surface fix + an image.json v68→69 bump) and `ffde14a` (queued the 0133-0139
notepad-EDIT-completeness set). Those are theirs; this commit is punes-only and
was reconciled onto their HEAD (queue.json keeps 0133-0139, drops only 0088;
image.json bumped 69→70 for the new seeded binary).

## Operator-owed (browser)

**0088 owes nothing here** — no `os-punes.mjs`, and none is required: the kernel
e2e (`test_punes_e2e.js`, headless PPM pixel test through the real compositor) is
the committed acceptance, matching the SameBoy/mGBA precedent (kernel-e2e-only).

The standing **0064** browser debt is unchanged and separate: the pointer-lock
human check + the 0094–0107 browser legs (incl. the unrun `os-paint.mjs`). Run
`node tests/browser/os-sweep.mjs` when Playwright is available (not installed
in-repo here).

## Gotchas carried forward (trimmed to the live ones)

- **Concurrent sessions exist: stage ONLY your own files**, and re-check HEAD
  before committing — it can advance mid-session (it did this time). Reconcile
  shared files (`queue.json`, `image.json`) against the *current* HEAD, not the
  base you started from.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (the rename shows `RM`/`R ` until re-added).
- **`--stale-ok` / a pre-baked image runs the STALE binary** — when iterating on
  a vendored `main.c`, drop `--stale-ok` or `rm` the image so boot.js re-bakes,
  else edits silently don't take.
- **Don't edit bake inputs while a suite runs** (0082): `.md`/`tests/` are NOT
  inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`, `vendor/` ARE. Bump
  `image.json` `version` (now **70**) when seeded-source edits must reach a
  persistent browser OPFS image.
- Kernel test files are auto-discovered by `tests/kernel/run.js` (glob), but
  confirm a new `test_*.js` is picked up.
- **Vendoring a mature C codebase**: watch include-shadowing (handled by the
  compiler since 0112), `#pragma pack` (silently ignored → mis-sized packed
  structs), `__attribute__((constructor))` (no ctor pass — gate off), and
  attribute-after-param-declarator (fixed by 0088).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium with
  `--enable-unsafe-webgpu --enable-features=Vulkan`.

## Next in queue

`node todos/queue.js list` — after 0088: **0079/0080**, **0052/0053**, the
0083/0084 pair, **0064** (WM browser sweep round 3 — the standing operator
debt), and the 0133-0139 notepad-EDIT set another session just queued. Heavier
P1→P3 tail after.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0112's recorded decisions (see todos/done/); **0088's
calls (fresh SDL3 frontend, not the recovered pre-Qt one; puNES core vendored
verbatim; C++ DSP/scaler/l7zip excluded with crc/pic reimplemented in C; GPLv3
quarantine — puNES knowledge only flows INTO vendor/punes/; a uniform
CPU-written backdrop is the headless acceptance frame, per the mgba precedent —
tile-level rendering not chased)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0088 puNES just landed; next
is 0079/0080). 0064 WM sweep round 3 still owes the operator the pointer-lock
check and the 0094–0107 browser legs."
