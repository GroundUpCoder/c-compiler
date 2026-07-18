# mGBA shared jsmolka failure: bad compare/test instructions flush the pipeline

**Date:** 2026-07-18  
**Branch:** `mgba-shared-bug`  
**Scope:** shared ARM test 235 failure in compiler.js and clang builds

## Result

The shared failure is an upstream mGBA version bug, not a build-flag, port-patch,
runtime/ABI, undefined-behavior, or code-generation bug. The vendored mGBA
v0.10.5 (`26b7884`) predates upstream fix `d031892e55` (2025-06-21), titled
`ARM: cmn/cmp/teq/tst pc shouldn't flush the pipeline`.

jsmolka ARM test 235 executes `0xE15FF000`, a CMP encoding whose ignored `Rd`
field is 15. ARM compare/test instructions update flags but do not write a
destination register. Therefore `Rd=PC` must not redirect execution or refill
the pipeline.

In v0.10.5, `DEFINE_ALU_INSTRUCTION_S_ONLY_ARM` expands through the same
`DEFINE_ALU_INSTRUCTION_EX_ARM` tail as result-writing ALU instructions. That
tail tests `rd == ARM_PC` and calls `ARMWritePC(cpu)` unconditionally. At this
point `ARMStep` has already advanced architectural PC and shifted prefetch, so
`ARMWritePC` reloads prefetch from the advanced PC. The instruction immediately
following the CMP is discarded. Test 235 observes that discard because its
`mov r8, 1` never executes.

The backport adds an explicit `DO_WRITE` macro argument. Ordinary ALU
instructions pass 1 and retain PC-write behavior; the S-only CMP/CMN/TST/TEQ
family passes 0 and cannot enter the pipeline-refill tail. This is the exact
upstream mechanism, not a test-specific opcode exception.

## Why both wasm codegens failed, while “native upstream” passed

compiler.js and clang compiled the same faulty v0.10.5 C and correctly produced
the same ARM 235 behavior. The shared host runtime and wasm ABI were not
involved. The passing native reference used newer upstream source containing
the 2025 fix; it was not a native build of the exact vendored revision. A native
v0.10.5 interpreter follows the same unconditional `ARMWritePC` source path.

The configured defines are irrelevant to this handler: `M_CORE_GBA` selects the
GBA core, `MINIMAL_CORE=1` removes optional core/frontend facilities, and
`DISABLE_THREADING` selects synchronous operation. None condition the ARM ALU
macros. The three existing c-compiler patches likewise do not reach this file
or CPU state: version metadata, a GB-only serialization layout assertion, and
log-category constructor registration.

## Differential before and after

The ROM verdicts were captured from the framebuffer after 300 frames using the
temporary environment-gated null-SDL PPM dump described in the clang
differential. The dump was removed before commit. Both builds used these exact
vendored sources and the same host runtime.

| ROM | compiler.js before | compiler.js after | clang before | clang after |
| --- | --- | --- | --- | --- |
| `arm.gba` | Failed test 235 | Failed test 522 | Failed test 235 | Failed test 522 |
| `thumb.gba` | Failed test 230 | Failed test 230 | Failed test 102 | Failed test 102 |
| `memory.gba` | not previously recorded | All tests passed | not previously recorded | All tests passed |

ARM test 522 is a later, independent failure and is outside this item. The
unchanged THUMB results prove that clang test 102 and compiler.js test 230 are
also separate issues. In particular, clang test 102 is “Overflow flag
addition,” while compiler.js test 230 is THUMB multiple-transfer “Base in
rlist”; neither is a THUMB analog of ARM test 235. There is no identical shared
THUMB failure in the supplied differential.

## Regression

The built-in ROM in `vendor/mgba/src/main.c`, already exercised by
`tests/kernel/test_mgba_e2e.js`, now starts with the bad CMP encoding followed
by `B setup` and a fail spin. Correct no-flush execution takes `B setup` and
renders the established red MODE 3 frame. The old v0.10.5 behavior refills at
the advanced PC, skips `B setup`, enters the fail spin, and leaves the frame
black. Thus the existing pixel-level e2e guards the actual pipeline behavior,
not merely the source shape.

## Bearing on compiler.js crt0 task B

This finding removes jsmolka ARM 235 as a compiler.js codegen oracle. The
post-fix compiler.js ARM 522 and THUMB 230 failures still need independent
differentials before being attributed to codegen. It does not weaken the Mario
Tennis evidence: clang passes that crt0 and reaches the language selector while
compiler.js branches to `0x09000000`, so that real-ROM derail remains a distinct
compiler.js-only bug.
