# mGBA THUMB-230 triage — native upstream v0.10.5 vs our builds

**Date:** 2026-07-20
**Branch:** `mgba-thumb230-triage`
**Ticket:** `todos/0140-mgba-cpu-miscompile.md` (deferred, P3)
**Scope:** TRIAGE ONLY. No compiler.js hunt, no compiler.js edit. The one job:
run jsmolka `thumb.gba` through **genuinely native upstream mGBA v0.10.5** and
diff it against our builds — the diff that ARM-235 got and THUMB-230 never had.

## Verdict (unambiguous)

**The jsmolka `thumb.gba` "test 230" reproducer does NOT isolate a compiler.js
codegen bug. It is a muddy oracle and should be retired, exactly like jsmolka
ARM-235 was.** Two independent findings:

1. **Test 230 ("Base in rlist") is a genuine, still-unfixed *upstream* mGBA
   v0.10.5 emulation bug** — not codegen. Any faithful build fails it. There is
   **no upstream fix to backport** (the handler is byte-identical in current
   mGBA master).
2. **Native upstream v0.10.5 never even reaches test 230** — it halts *earlier*
   at **test 102** ("Overflow flag addition"), another genuine v0.10.5 bug that
   the clang golden build reproduces too. The *only* place our compiler.js build
   diverges from the two faithful reference builds on `thumb.gba` is **test 102**,
   where compiler.js is *coincidentally more* hardware-correct — a confusing,
   non-actionable signal.

**The real, actionable compiler.js codegen bug for ticket 0140 is the Mario
Tennis crt0 derail (`BX` to `0x09000000`), already cleanly pinned on compiler.js
by the clang differential (`logs/2026-07-18/mgba-clang-differential.md`): clang
boots the real ROM to the language-selection screen; compiler.js derails.** The
fix (out of scope here) must anchor on Mario Tennis, the clean compiler.js-only
oracle — **not** on jsmolka `thumb.gba`. Because that fix re-enters the
deliberately-untouched `compiler.js`, this is a **go/no-go for jku**.

## The three-way differential

| ROM | native v0.10.5 (x86-64, faithful) | clang→wasm (faithful) | compiler.js→wasm |
|---|---|---|---|
| `arm.gba` | **Failed 235** (this run) | Failed 235 (prior) | Failed 235 (prior) |
| `thumb.gba` | **Failed 102** (this run) | Failed 102 (prior) | **Failed 230** (prior ×3) |

- **native column = produced fresh in this triage** (method below).
- **clang column** = `logs/2026-07-18/mgba-clang-differential.md` (independent
  clang→wasm golden build over the *same* `host.js`).
- **compiler.js column** = three committed sources agree: `todos/MGBA.md`,
  `todos/0140`, and both 2026-07-18 dev logs (`mgba-clang-differential.md`,
  `mgba-shared-jsmolka-bug.md`). Not re-derived here (full-OS headless boot;
  the number is thrice-documented and the verdict does not turn on re-running it).

**The two independent faithful codegens agree** (native x86 *and* clang→wasm both
halt at 102). compiler.js is the lone outlier at 230. jsmolka halts at the first
failing test (confirmed empirically: native shows exactly one stable number —
102 at both 60 and 240 frames, 235 for arm — not a changing counter).

## What tests 102 and 230 actually are (jsmolka thumb suite)

Section layout (running counter): logical 1+, shifts 50+, arithmetic 100+,
branches 150+, memory 200+.

- **Test 102** = arithmetic.asm 3rd test, **"Overflow flag addition"** (V flag on
  ADD near the sign boundary).
- **Test 229** = "THUMB 15: Store empty rlist"; **Test 230** = **"THUMB 15: Base
  in rlist"**, i.e. `stm r1!, {r0-r3}` where the base **r1 is in the list and is
  NOT the lowest register**.

## Why test 230 is an upstream bug, and why it's masked

Vendored (and current-master, byte-identical) THUMB STMIA handler, `src/arm/
isa-thumb.c`:

```c
DEFINE_LOAD_STORE_MULTIPLE_THUMB(STMIA,
    (opcode >> 8) & 0x0007, store, IA, ,
    THUMB_STORE_POST_BODY;
    cpu->gprs[rn] = address;)   // writeback runs AFTER the store loop
```

`GBAStoreMultiple`'s loop stores `cpu->gprs[i]` for each set bit; the base
write-back (`cpu->gprs[rn] = address`) only happens *after the loop returns*. So
when the loop stores r1 it stores the **old** base. ARM7TDMI hardware, for
`stm r1!, {r0-r3}` (r1 not the lowest register in the list), stores the
**written-back (new)** base. v0.10.5 therefore gets test 230 wrong — a real
emulation bug in the source, which a faithful build reproduces. compiler.js
failing test 230 is *faithful*, not a miscompile.

It is masked in the reference builds only because they fail test 102 first and
halt. Current mGBA master has the **identical** handler (I diffed
`26b7884bc..HEAD` on `src/arm/isa-thumb.c` and `src/gba/memory.c`: the only
changes since v0.10.5 are whitespace, `bpkt` cycles, `bx pc` alignment, and
cosmetic macro renames `WORKING_RAM→EWRAM` / `WORKING_IRAM→IWRAM`). **No upstream
fix exists** — the opposite of ARM-235, which had `d031892e55` to backport
(`dc7054e`, worktree `mgba-shared-bug`).

## Native oracle — method (hermetic, in /tmp, no shared build path)

Upstream mGBA cloned to `/tmp/mgba-upstream-t230`, checked out **v0.10.5 =
`26b7884bc`** (matches the vendored revision exactly). Built only the headless
`mgba-perf` runner (no SDL/Qt/GL/zlib/png), minimal-core GBA. `perf-main.c` runs
a ROM headless through the software renderer into a 256-stride RGBA buffer; a
throwaway env-gated PPM dump of the 240×160 region was added to that runner only
(never our tree). ROMs are jsmolka's exact `arm.gba`/`thumb.gba` from the prior
investigation's throwaway clone.

```
~/.local/bin/cmake .. -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_PERF=ON -DUSE_ZLIB=OFF -DUSE_PNG=OFF \
  -DM_CORE_GB=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build . --target mgba-perf
MGBA_PPM_OUT=thumb.ppm ./mgba-perf -F 240 thumb.gba   # -> "Failed test 102"
MGBA_PPM_OUT=arm.ppm   ./mgba-perf -F 60  arm.gba     # -> "Failed test 235"
```

**Oracle validated:** native v0.10.5 `arm.gba` = "Failed test 235", exactly the
known ARM-235 result (the bug `dc7054e` backports). The build faithfully
reproduces v0.10.5.

## Bearing on ticket 0140

- **jsmolka `thumb.gba` is retired as a compiler.js oracle** (test 230 = upstream
  base-in-rlist bug; the only compiler.js thumb divergence is at test 102, where
  compiler.js is *more* correct). This joins jsmolka ARM 235 (upstream, retired
  by ARM-235) — the CPU-suite ROMs are not clean compiler.js oracles.
- **0140 still needs a real compiler.js codegen fix**, but anchored on the
  **Mario Tennis crt0 derail** (clean, game-relevant, clang-differential-pinned),
  not thumb-230. That fix touches `compiler.js` → **go/no-go for jku**.
- No backport applied: there is nothing upstream to backport for test 230, and
  base-in-rlist correctness is not what 0140 asks for (and is masked anyway).
- No deploy, no image change, no compiler.js change.
