# mGBA: real GBA games derail — a compiler.js CPU-codegen bug

**Date:** 2026-07-12
**Refs:** todos/0140 (deferred), todos/MGBA.md (design/evidence), todos/done/0112
(the original port), commit fa79315 (alpha fix)

## Why this thread happened

0112 shipped `/bin/mgba` and closed as "working, verified." The acceptance was
`test_mgba_e2e.js`: a headless PPM pixel check that the built-in **MODE 3 test
ROM** paints a red frame. It passed. But that ROM is a dozen hand-assembled ARM
words filling VRAM with red — it exercises almost none of the CPU and none of
the tiled/sprite/DMA/IRQ/BIOS machinery a real game uses.

The user tried a real game in the browser and saw a **pure white window**.
Earlier in the thread I (wrongly) chased this as a display/alpha bug and
"proved it worked" by showing **SameBoy** rendering Super Mario Bros. Deluxe —
which was irrelevant: `.gbc` routes to SameBoy, not mGBA, and mGBA is GBA-only.
The user (correctly) called that out. This log is the real investigation.

## Setup (kept the main repo clean)

- Isolated clone `~/git/c-compiler-copy` at committed HEAD (so the concurrent
  session's uncommitted puNES/edit-control work was excluded), Playwright copied
  in from a sibling repo (no download, no pollution).
- Real ROMs: jsmolka `arm.gba`/`thumb.gba`/`memory.gba` (free, MIT), and the
  user's `MarioTennisAdvancePowerTour.gba` (16 MB commercial).
- `tests/kernel/mgba-real-rom.js`: boot headless → `mgba <rom>` → `wmctl shot`
  → PNG + histogram. `tests/browser/mgba-diag.mjs`: composited-pixel capture.

## Findings, in order

**1. Display works; the CPU is the problem.** `arm.gba` renders sharp tiled
text — "Failed test 235" — on the white background. So the tiled renderer,
font, framebuffer copy, and WebGPU compositor are all fine. The alpha fix
(fa79315) was real but unrelated.

**2. The CPU is miscompiled.** jsmolka's suites are self-checking oracles:
- `arm.gba` → **Failed test 235** (tests 1–234 pass)
- `thumb.gba` → **Failed test 230** (tests 1–229 pass)

Basic ALU/shift/flag instructions pass in isolation. Test 235 is
data_processing's last case, "Bad CMP/CMN/TST/TEQ do not flush the pipeline"
(`0xE15FF000` = a CMP with Rd=PC that must not write PC).

**3. Real games derail hard.** Mario Tennis: `GBA core ready (MARIOTENNISA)`,
then `Jumped to invalid address: 09000000` on repeat, blank white frame.

**4. It's not ROM loading.** Instrumenting the bad-jump site: `romSize=0x01000000`
(full 16 MB), `romMask=0x00FFFFFF`. The ROM is whole and correctly mapped;
`0x09000000` is genuinely past it.

**5. Pinpointed the corrupted register.** `lr=0x080004A0`, THUMB, before the
first SWI → the game's ARM crt0:
```
0x08000494  LDR r1, [pc, #0x14]   ; ROM literal @ 0x080004B0 = 0x08013349
0x08000498  MOV lr, pc            ; lr = 0x080004A0  ✓ matches the crash
0x0800049C  BX  r1                ; should enter THUMB fn @ 0x08013348
```
The literal in the ROM really is `0x08013349`. Our emulator has `r1 =
0x09000001` at the `BX` and jumps to `0x09000000`. A register is corrupted at/
before this point (or one call deeper — `lr` is the still-live outer return).

**6. mGBA itself is golden — it's compiler.js.** The user asked the right
question: why edit mGBA? Answer: I didn't fix mGBA, only added throwaway trace
instrumentation. The CPU core (`src/arm/*`) is byte-for-byte upstream (no
`PATCH(c-compiler)`/`__MTOTS__` markers), the decode tables are `const` static
arrays (not runtime-built, so the constructor patch can't break them), and the
3 real patches are cosmetic/GB-only. mGBA passes jsmolka natively → **our
compiler miscompiles correct C.** This is the same class 0112 already hit 4×
(angle-includes, `__builtin_bswap`, `exp2`, `rewinddir`).

## Gotchas burned on (worth not re-learning)

- **`page.screenshot()` can't see the WebGPU OffscreenCanvas** (worker-owned) —
  it renders blank navy. Read the `#screen` canvas back via a 2D-canvas
  `drawImage` → `toDataURL`/`getImageData` for real composited pixels.
- **boot.js didn't re-bake on vendor/mgba source edits** — the input-freshness
  gate kept a stale cached blob, so edits silently didn't take. Pass
  `--fresh-system`. (Possible real staleness-gate gap: does `newestBakeInput`
  walk vendor project *sources* or just the bin.json mtime? Worth a look.)
- **Backgrounded-emulator `printf` is lost** (fully buffered; the process is
  `kill %1`ed before flush). `mLOG(...)` flushes and shows; raw `printf` needs
  `fflush(stdout)`. And only `WARN`/`FATAL` mLOG levels print — `GAME_ERROR`/
  `DEBUG` are filtered out in this build.

## Decision: defer

Root-causing a compiler.js codegen bug in an ARM interpreter is an open-ended
correctness hunt. Filed as **todos/0140** at P3/background (the queue's
deferral mechanism — there is no separate "icebox" flag; P3 is the bottom
bucket), with the technical record in **todos/MGBA.md**. The throwaway debug
harness stays in `~/git/c-compiler-copy` (uncommitted).

## Follow-up: can clang build it? (the golden-reference question)

Asked whether `~/git/clang-simplified` (cc2wasm — an in-repo clang→wasm that
targets the same host.js and already ships `doom-clang`) could build mGBA as a
trustworthy reference. Tried it: **yes, it compiles all 78 TUs; the only
blockers are libc-completeness gaps — the very same ones the compiler.js port
had to fill** (`exp2f` undeclared; `rewinddir` absent from cc2wasm's libc). That
is itself corroborating: mGBA's C is portable and fine — what's missing is libc
surface, not correct codegen. Didn't push through the small cc2wasm-libc port to
a linked/running binary, so the definitive "clang passes, compiler.js fails"
differential is captured as the top un-defer step in todos/MGBA.md rather than
done. (zsh gotcha for whoever resumes: unquoted `$SRCS` won't word-split — use a
zsh array.)

## Correcting the record

0112's "verified working" overstated a test-ROM-only result. Left as-is
historically, but MGBA.md/0140 now state plainly: mGBA runs the test ROM, not
real games, until the CPU codegen bug is fixed.
