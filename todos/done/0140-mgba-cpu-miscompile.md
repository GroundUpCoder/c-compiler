# 0140 — mGBA: real GBA games derail — ROOT-CAUSED to an in-OS short-read (NOT compiler.js codegen)

- **CLOSED — DONE 2026-07-22 (@master cont-19).** The option-B in-OS read-fill
  fix is **MERGED to main (`2eb7e4e`, "Merge 0140 fix: in-OS read() fills
  regular-file reads (option B) — mGBA short-read class") and LIVE** — kernel.js
  ships as a static OS asset and this change rode into the deployed apex (v139 or
  earlier). Meaningful acceptance is MET: a real commercial ROM (Mario Tennis)
  boots in-OS with mGBA source UNCHANGED (0 invalid-address lines, 1417
  DMA-to-VRAM/OAM, 88.2%-non-white composited title). The layered
  "compiler.js miscompiles the ARM/THUMB core" framing below is **RETIRED** — the
  crt0 derail was the FS short-read, not codegen (proven bare: capping bare
  readImpl to 60 KB reproduces it; compiler.js was never edited, no conformance
  defect exists). The jsmolka `arm.gba`/`thumb.gba`-all-pass acceptance line is
  **moot**: the THUMB-230/ARM-235 oracles were triaged as muddy/genuine-upstream
  bugs with NO upstream fix (thumb 102 is where compiler.js is *coincidentally
  more* hardware-correct). No product code, no compiler.js edit, no separate
  deploy pending. Reopen only if a NEW real-ROM derail surfaces.

- **FIX LANDED 2026-07-20 (option B, `logs/2026-07-20/os-read-fill-0140.md`,
  branch `os-read-fill-0140`).** jku picked **option B only** (the
  general in-OS read-fill; option A — patching mGBA's unlooped read — was
  rejected: the bug is ours, not upstream's). `RemoteFS.prototype.read`
  (kernel.js) now FILLS a regular-file `read(fd, buf, N>KP_FS_CHUNK)` up to
  `count` by looping the `FS_READ` RPC (each reply is payload-capped, so the
  loop is process-side), matching native/Node `fs.readSync`. **Scoped to
  regular files** via a `_isRegularFd` fstat (S_IFREG) + a first-chunk-full
  gate — ttys/pipes/sockets/char-devices keep POSIX short-read semantics
  untouched. Regression: `tests/kernel/test_read_fill_e2e.js` (fails pre-fix
  `rv=60000`, passes after; includes a pipe scope-proof leg). Verified:
  kernel gate 95/95 real (the 1 fail is the known gucman_quake cold-bake
  flake), and the real Mario Tennis ROM boots in-OS with mGBA source UNCHANGED
  — **0** invalid-address lines (was 1.5 M), **1417** DMA-to-VRAM/OAM, a
  88.2%-non-white composited title frame. compiler.js untouched.
- **ROOT CAUSE FOUND 2026-07-20 (`logs/2026-07-20/mgba-crt0-codegen-fix.md`,
  branch `mgba-crt0-codegen-fix`) — the whole "compiler.js miscompiles the
  ARM/THUMB core" premise is WRONG.** The Mario Tennis crt0 derail (`BX` →
  `0x09000000`) is **not a codegen bug**: the *identical* mgba wasm boots the
  ROM **clean** under bare `node host.js` (compiler.js AND clang agree); it
  derails **only in-OS**. Trigger: the in-OS RemoteFS/kernel `read()` caps each
  `FS_READ` RPC at `KP_FS_CHUNK` (a **short read** — proven by `dd`: a single
  16 MB / 1 MB read returns one *partial* block, `bs=64k` → `0+280` partial
  blocks). mGBA's non-`mmap` `_vfdMap` (`vfs-fd.c`) loads the 16 MB ROM with a
  **single unlooped `read(fd, mem, 16MB)` whose return value is ignored**, so
  the `calloc`-zeroed ROM buffer is left mostly empty → the emulated CPU reads
  open-bus ROM → `0x09000000`. Bare `fs.readSync` fills 16 MB in one call, so
  bare boots. **Causation proven bare:** capping bare `readImpl` to 60 KB/call
  reproduces the exact derail; looping `_vfdMap`'s read fixes it (clean boot).
  compiler.js is UNTOUCHED and no conformance test was added (no C codegen
  defect exists). **Awaiting master:** pick the fix site — **(A)** loop
  `_vfdMap`'s read (mgba-only, upstream-worthy), or **(B, recommended P0)** make
  the in-OS `read()` fill up to `count` for regular files (fixes the WHOLE class
  — any in-OS program doing one large `read()` of a regular file is silently
  truncated today). Reclassify accordingly; the codegen framing below is retired.
- **Status**: done (mGBA short-read fix merged 2eb7e4e + live) — was deferred
  (mass-deferred 2026-07-12) as an open-ended compiler
  correctness hunt. That framing is RETIRED by the 2026-07-20 root cause above —
  it is an FS short-read / mgba VFS-fallback bug, not a compiler bug. Design +
  historical evidence: `todos/MGBA.md`. Historical narrative:
  `logs/2026-07-12/mgba-real-games-cpu-miscompile.md`.
- **THUMB-230 triage verdict (2026-07-20, `logs/2026-07-20/mgba-thumb230-triage.md`)**:
  jsmolka `thumb.gba` "test 230" is a **muddy oracle — retired** (like ARM-235).
  Fresh native upstream mGBA **v0.10.5** (`26b7884bc`, matches vendored) run:
  `thumb.gba` → **Failed test 102** (not 230); `arm.gba` → Failed 235 (oracle
  validated vs the ARM-235 result). So native + the clang golden build **agree**
  (both halt at 102); compiler.js is the lone outlier at 230. Two facts: (1) test
  230 ("Base in rlist", `stm r1!,{r0-r3}`) is a genuine **upstream** v0.10.5 bug
  (STMIA writeback runs after the store loop → stores old base; hardware stores
  the new base) with **no upstream fix** (handler byte-identical in current
  master) — so nothing to backport; (2) the *only* compiler.js `thumb.gba`
  divergence is at test 102 (overflow-flag ADD), where compiler.js is
  *coincidentally more* hardware-correct. **The real, actionable compiler.js
  codegen bug for 0140 remains the Mario Tennis crt0 derail** (`BX`→`0x09000000`),
  cleanly pinned by the clang differential — the fix must anchor there, NOT on
  jsmolka thumb. That fix re-enters the deliberately-untouched `compiler.js` →
  **go/no-go for jku**. No backport, no compiler.js edit, no deploy this pass.
- **Design**: todos/MGBA.md

## Goal

Make `/bin/mgba` run **real** GBA games (not just the built-in MODE 3 red-fill
test ROM that 0112 shipped). Today every real ROM derails: the ARM7TDMI core
computes a wrong value early in the game's crt0 and branches off the end of the
ROM → `Jumped to invalid address` loop → blank white window.

## What we know (see todos/MGBA.md for the full trace)

- **Not a display bug.** The compositor/alpha path is correct — `arm.gba`
  renders tiled text ("Failed test 235") perfectly. The CPU core is the problem.
- **Not a port bug.** mGBA's `src/arm/` (isa-arm.c, isa-thumb.c, arm.c, the
  decoders) is byte-for-byte upstream; the decode tables are `const` static
  arrays. The 3 `PATCH(c-compiler)` patches don't touch the CPU. mGBA passes
  jsmolka's suites natively — so **our build miscompiles correct C**.
- **Reproduced** (jsmolka gba-tests, free/MIT): `arm.gba` fails at test 235,
  `thumb.gba` at test 230 (tests 1–234 / 1–229 pass — basic ALU/shift/flags are
  fine). Mario Tennis derails in its crt0 before its first SWI: a `LDR r1,[pc]`
  literal that should be `0x08013349` ends up making `BX r1` jump to
  `0x09000001`.

## Plan (when un-deferred)

Two convergent tracks (detail in todos/MGBA.md):

- **Clang golden build (confirm + maybe ship).** Build the same mGBA sources
  with `~/git/clang-simplified`'s `cc2wasm` (already ships `doom-clang`). Tried
  2026-07-12: it compiles all 78 TUs; blocked only by the SAME libc gaps the
  compiler.js port filled (`exp2f`, `rewinddir` — cc2wasm's libc lacks
  rewinddir entirely). Finish that small libc pass → link → run `arm.gba` +
  a real ROM through `host.js` and diff stdout. If clang boots clean where
  compiler.js derails, the bug is pinned on compiler.js — and the clang binary
  could ship as `mgba-clang` in the clang-apps overlay.
- **Compiler fix (compiler.js path).** Land the ring-buffer trace (last ~48
  instrs dumped at the bad jump) to name the miscompiled handler → minimal
  codegen repro → fix + conformance test → re-green jsmolka + a real ROM.

## Acceptance

- jsmolka `arm.gba` / `thumb.gba` / `memory.gba` all print "Passed"/all tests.
- At least one real commercial `.gba` renders its title screen in-OS
  (headless PPM pixel proof + a browser composited-pixel check).
- The compiler fix carries a `tests/unit/conformance/` regression entry.
