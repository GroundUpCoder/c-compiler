# mGBA — design notes & the "real games don't run" bug

`/bin/mgba` (todos/0112, done) is mGBA 0.10.5's C core built GBA-only
(`-DM_CORE_GBA -DMINIMAL_CORE=1 -DDISABLE_THREADING`) behind an SDL3 frontend
(`vendor/mgba/src/main.c`). It renders through the software renderer into a
32-bit RGBA framebuffer that the frontend copies to the SDL surface.

## Current status (2026-07-12)

**0112 shipped a working *emulator shell* but no real game has ever run.** The
only thing exercised was the built-in MODE 3 test ROM — a dozen hand-assembled
ARM words that fill VRAM with red. That path touches the ALU, one store loop,
the bitmap renderer, and the framebuffer copy. It does **not** touch tiled
backgrounds, sprites, DMA, IRQs, the HLE BIOS, or the vast majority of the CPU.

Every **real** GBA ROM derails. Tracked as **todos/0140** (deferred, P3).

## Symptom

Running any real `.gba` (e.g. Mario Tennis Advance, or jsmolka's CPU test
ROMs):

- Core initializes fine: `GBA core ready (MARIOTENNISA)`.
- Within the game's crt0 the CPU computes a wrong value and branches off the
  end of the ROM. mGBA logs `Jumped to invalid address: 09000000`, then loops
  fetching garbage (`Illegal opcode: 0000b710 / 0000ea00`).
- The window composites, but the framebuffer is **100% white** (nothing ever
  rendered). This is the "pure white" seen in the browser.

## What it is NOT

- **Not a display/compositing/alpha bug.** The `| 0xFF000000` opaque-alpha fix
  (commit fa79315) is correct and necessary, but unrelated. Proof: jsmolka's
  `arm.gba` renders crisp tiled text ("Failed test 235") — the tiled BG
  renderer, font, framebuffer copy and compositor all work.
- **Not a ROM-loading / memory-map bug.** At the crash, `romSize=0x01000000`
  (full 16 MB) and `romMask=0x00FFFFFF` — the ROM is loaded whole and mapped
  correctly. `0x09000000` is genuinely past a 16 MB ROM; the CPU should never
  branch there.
- **Not a port/"ripped-out" bug.** mGBA's CPU core is **unmodified upstream**:
  - `src/arm/{arm.c,isa-arm.c,isa-thumb.c,decoder*.c}` carry zero
    `PATCH(c-compiler)` / `__MTOTS__` markers.
  - `_armTable[0x1000]` and `_thumbTable[0x400]` are `const` static arrays
    (compile-time, not runtime-constructed) — so the constructor patch
    (below) can't leave them uninitialized.
  - The 3 patches are all cosmetic/irrelevant to the CPU: `version.c` (CMake
    stub), `gb/serialize.h` (`#pragma pack` on **GB** savestate structs — the
    GB core isn't even compiled for GBA), and `common.h` (drops
    `__attribute__((constructor))`, which per its own comment only affects
    `mLOG` category IDs — cosmetic).
  - `MINIMAL_CORE=1` drops the video-logger/proxy/HLE-mixer, none of which is
    the CPU.

## What it IS

**A `compiler.js` codegen bug**: compiler.js miscompiles the (correct, upstream)
mGBA ARM/THUMB interpreter. mGBA passes jsmolka's suites natively, so a failure
in our build is our compiler miscompiling correct C — the same class of finding
that the 0112 port already surfaced four times (angle-includes, `__builtin_bswap`,
`exp2`, `rewinddir`).

## Reproductions (deterministic)

Free, redistributable ARM test ROMs from **jsmolka/gba-tests** (MIT):

| ROM | Result in our build | Meaning |
|---|---|---|
| `arm.gba` | **Failed test 235** | tests 1–234 pass; #235 = data_processing "Bad CMP/CMN/TST/TEQ do not flush the pipeline" (`0xE15FF000`, a CMP with Rd=PC) |
| `thumb.gba` | **Failed test 230** | tests 1–229 pass |
| `memory.gba` | (run pending) | |

> **Both jsmolka CPU-suite ROMs are now RETIRED as compiler.js oracles.**
> ARM 235 is an upstream v0.10.5 bug (fixed upstream by `d031892e55`, backported
> in `dc7054e`; `logs/2026-07-18/mgba-shared-jsmolka-bug.md`). THUMB 230 was
> triaged 2026-07-20 (`logs/2026-07-20/mgba-thumb230-triage.md`): a fresh *native*
> upstream v0.10.5 run fails `thumb.gba` at **test 102** (overflow-flag ADD), not
> 230 — agreeing with the clang golden build. Test 230 ("Base in rlist") is itself
> a genuine, still-unfixed upstream v0.10.5 bug (STMIA writeback-after-loop stores
> the old base); the *only* compiler.js `thumb.gba` divergence is at test 102,
> where compiler.js is coincidentally more hardware-correct. Use **Mario Tennis
> crt0** (clang differential) as the clean compiler.js codegen oracle, not these.

Tests are numbered by category (conditions 1+, branches 50+, flags 100+,
shifts 150+, data_processing 200+, psr 250+, multiply 300+, single_transfer
350+, halfword 400+, data_swap 450+, block_transfer 500+). arm.gba stops at the
first failure. That most instructions pass in isolation but a real game still
derails suggests the miscompile bites an instruction/edge the suites reach late
(235/230) and that game crt0 hits early.

## The Mario Tennis crt0 trace (root-cause anchor)

Derails **before the first SWI**, in ARM-mode startup at ~`0x0800049C`:

```
0x08000494  LDR r1, [pc, #0x14]   ; literal @ 0x080004B0 = 0x08013349 (correct)
0x08000498  MOV lr, pc            ; lr = 0x080004A0  (matches the crash lr)
0x0800049C  BX  r1                ; should enter THUMB fn at 0x08013348
```

The ROM literal at `0x080004B0` really is `0x08013349` (valid THUMB target
`0x08013348`). **Our emulator instead has `r1 = 0x09000001` at the `BX`** and
jumps to `0x09000000`. So a register is corrupted between/at these instructions
(or the derail is one call deeper — `lr=0x080004A0` is the outer return still
live). The next diagnostic step names the exact instruction.

## Debug harness (lives in the throwaway copy, NOT committed)

Investigation ran in an isolated clone (`~/git/c-compiler-copy`) so the main
repo stayed clean. Reproduce there:

- `tests/kernel/mgba-real-rom.js <romPath> <outPng>` — boots the OS headless,
  runs `mgba <rom>`, `wmctl shot`s the frame, writes a PNG + a color histogram.
  **Must pass `--fresh-system` to boot.js** (added in the script): the
  input-freshness gate did not re-bake on vendor/mgba source edits, so a stale
  cached blob shadowed the changes.
- `tests/browser/mgba-diag.mjs` — real-Chromium composited-pixel capture via
  the `#screen` canvas → `toDataURL` (Playwright `page.screenshot()` does NOT
  capture the worker's WebGPU OffscreenCanvas — it looks blank; use the canvas
  read-back).
- Trace instrumentation added to `vendor/mgba/src/{arm/arm.c, gba/gba.c,
  gba/memory.c, gba/bios.c}`: a 128-entry ring buffer of (pc, opcode, r1)
  recorded in `ARMStep`/`ThumbStep`, dumped at the bad-jump site. **Gotchas:**
  raw `printf` from a backgrounded emulator process is lost (buffered, killed
  before flush) — either use `mLOG(...)` (which flushes) or `fflush(stdout)`;
  and only `WARN`/`FATAL` mLOG levels are visible (`GAME_ERROR`/`DEBUG` are
  filtered).

## Golden-reference build via clang (`clang-simplified` / cc2wasm) — viable but unfinished

The obvious way to *prove* the diagnosis (and maybe ship a working `/bin/mgba`
sidestepping the compiler.js bug) is to build the same mGBA sources with the
sibling `~/git/clang-simplified` toolchain — `cc2wasm`, an in-repo clang+wasm-ld
that targets the SAME `host.js` runtime and already ships `doom-clang` (a full
SDL C game) in the `clang-apps` overlay (image.json). A clang build is
trustworthy codegen; if it passes jsmolka / boots a real ROM, that pins the bug
on compiler.js.

**Attempted 2026-07-12. It compiles — the blockers are libc completeness, not
codegen or any fundamental incompatibility.** Invocation (from `vendor/mgba/`):

```
cc2wasm --sdl <bin.json compilerArgs, minus --allow-zero-length-arrays> \
        -Iinclude -Isrc -Isrc/third-party/blip_buf -Isrc/third-party/inih \
        <the 78 bin.json sources> -o mgba-clang.wasm
```
(NB: the driver shell here is **zsh** — unquoted `$SRCS` does NOT word-split;
build the source list into a zsh array `SRCS=(${(f)"$(cat list)"})`.)

cc2wasm chews through all 78 TUs. Every error hit so far is one of the **same
libc gaps the compiler.js port itself had to fill** (see vendor/mgba/README.md
"Compiler improvements this port drove"):

- `exp2f`/`exp2` — undeclared in cc2wasm's libc `<math.h>`. Bridged for the
  experiment with `-Dexp2f=__builtin_exp2f -Dexp2=__builtin_exp2`.
- `rewinddir` — **not present at all** in cc2wasm's libc (`wasm/libc/__dirent.c`
  has opendir/readdir/closedir over the `__opendir/__readdir/__closedir` host
  imports; no rewinddir). Needs a real implementation (re-open by name, or an
  `__rewinddir` host import) exactly like compiler.js's libc added.

Not finished: didn't reach a linked binary or run it, so the differential
"clang build passes, compiler.js build fails" confirmation is **not yet done** —
it's the highest-value next step and is very likely to succeed. Remaining work
is a small cc2wasm-libc porting pass (add `rewinddir`, confirm `exp2f`/`bswap`/
angle-include parity), then link + run `arm.gba` and a real ROM through
`host.js`, comparing stdout (`Jumped to invalid address` on compiler.js vs a
clean boot on clang) — no display needed.

## Plan when un-deferred

See todos/0140. Two convergent tracks:
1. **Confirm & possibly ship (clang path):** finish the cc2wasm build above →
   golden reference proves the compiler.js bug, and could ship as an
   `mgba-clang` in the clang-apps overlay (like doom-clang).
2. **Fix the compiler (compiler.js path):** land the ring-buffer dump → name the
   miscompiled handler → minimal compiler.js codegen repro → fix + conformance
   test → re-green jsmolka + one real ROM to title screen.
