# 0140 — mGBA: real GBA games derail — ARM/THUMB core miscompiled by compiler.js codegen (deferred)

- **Status**: open — DEFERRED INDEFINITELY (P3/background). Root-cause is a
  compiler.js codegen bug in the (unmodified, upstream) mGBA ARM/THUMB
  interpreter; fixing it is an open-ended compiler correctness hunt with no
  committed timebox. Design + full evidence: `todos/MGBA.md`. Investigation
  narrative: `logs/2026-07-12/mgba-real-games-cpu-miscompile.md`.
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

1. Land the ring-buffer trace (last ~48 executed instrs, dumped at the bad
   jump) to name the exact miscompiled instruction/handler. (Scaffolding exists
   in the throwaway copy — see MGBA.md.)
2. Reduce to a standalone compiler.js codegen repro (compile the suspect mGBA
   handler / a minimal C analog, diff vs clang/cc2wasm output).
3. Fix in compiler.js; add a conformance test; re-run jsmolka arm/thumb/memory
   to green, then a real commercial ROM boots to title.

## Acceptance

- jsmolka `arm.gba` / `thumb.gba` / `memory.gba` all print "Passed"/all tests.
- At least one real commercial `.gba` renders its title screen in-OS
  (headless PPM pixel proof + a browser composited-pixel check).
- The compiler fix carries a `tests/unit/conformance/` regression entry.
