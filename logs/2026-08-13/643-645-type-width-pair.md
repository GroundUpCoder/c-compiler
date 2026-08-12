# #643 + #645 — two compiler type-width correctness bugs (batched lane, §3a)

Lane `lane/643`, branched from `5149737b`. One commit per ticket, distinct
instruments, fixes in different functions (§3a.4 held: #643 in
`usualArithmeticConversions`, #645 in `constEvalExpr`'s EBinary case).
Unit baseline re-verified pre-change: **830/0/3** (the ticket bodies' 825
figure predates #642's four tests).

## Target probe (the #643 prerequisite)

Compiled probe, not headers: `sizeof(int)=4 sizeof(long)=4
sizeof(unsigned long)=4 sizeof(long long)=8` — **ILP32**. So for
`long + unsigned int` C11 6.3.1.8p1 takes the same-width branch: `long`
cannot represent every `unsigned int` value, so both operands convert to
**`unsigned long`** (never `long`, and never the observed `unsigned int`).

## #643 — UAC ranked by size, not conversion rank (`e6a1d185`)

`usualArithmeticConversions` used byte size as the rank proxy. Two defects:

- **Same signedness, equal width:** `aSize >= bSize ? a : b` returns the
  FIRST operand, so `int + long -> int` but `long + int -> long` —
  order-dependent. C ranks `long` above `int` regardless of width
  (6.3.1.1p1).
- **Mixed signedness, equal width:** `if (uSize >= sSize) return unsignedT`
  fired before the corresponding-unsigned rule could, making `toU(signedT)`
  unreachable. `long + unsigned int -> unsigned int`; C requires
  `unsigned long`.

Fix: an explicit rank table (int/uint=1, long/ulong=2, llong/ullong=3;
non-canonical error-recovery types rank 0 and fall back to width) driving
the three 6.3.1.8p1 rules in order. Enums were probed to reach the function
as `TINT`, so canonical types are the only live inputs.

**Observability on this target:** every wrong cell shares width AND
signedness with the right answer (uint vs ulong, int vs long), so plain
arithmetic values coincide — the value-observable defect is `_Generic`
dispatch selecting the wrong arm (`dispatch 2` pre-fix vs `1` post-fix in
the conformance test), which is a differing value in a conforming program.
The full 30-cell matrix + ternary/comparison legs are clang-verified at
`-target i686-pc-linux-gnu -fsyntax-only` via a `_Static_assert` twin (the
ilp32_long_literal_typing precedent — an LP64 host oracle types `l + ui`
as `long` and cannot check this). Pre-fix, 7 of 33 output lines diverge.

Test: `tests/unit/conformance/uac_rank_mixed_sign/`.

## #645 — shift fold bound hardcoded at 64 (`629bbcae`)

Divergence probed BEFORE the fix, per the ticket, in two passes:

1. **Local expressions: all AGREE.** Sema's `ConstEval.binary` already
   declines counts >= the promoted left width, and codegen then emits the
   runtime wasm shift, which masks the count. No fold, no divergence.
2. **Static initializers: DIVERGE.** `constEvalExpr` (the mandatory
   static-initializer fold) bounded counts by a literal `64n`:

   | static initializer | folded | runtime (volatile twin) |
   |---|---|---|
   | `1 << 32` (int) | 0 | 1 |
   | `1 << 33` (int) | 0 | 2 |
   | `1u << 32` | 0 | 1 |
   | `(signed char)1 << 40` (prom. int) | 0 | 256 |
   | `-8 >> 32` | -1 | -8 |
   | `0x80000000u >> 32` | 0 | 2147483648 |
   | `1ll << 64` | already declined (error) | masks |

   So the ticket is **CONFIRMED**, with the reproduction confined to the
   static-initializer path — the same expression folded one answer at file
   scope and computed another in a function.

Fix: the SHL/SHR fold in `constEvalExpr` now bounds the count by the
**promoted left operand's width** — `expr.type`, which sema computes as the
promoted left type (bitfields included), clamped up to int as a belt for
any unpromoted type — and **declines** out-of-range counts, exactly like
`ConstEval.binary` and like `>= 64` always did. Declining means a static
initializer with a UB count is now a compile error ("initializer element is
not a compile-time constant") rather than a silently wrong constant; local
expressions keep runtime masking, so fold and runtime can no longer
disagree. Mask-folding (defining the UB to match wasm) was considered and
rejected: the repo convention is decline-so-runtime-semantics-stand
(float→int folding, CLAUDE.md conformance notes), and `1ll << 64` already
errored this way — the fix unifies the rule rather than adding a second
behavior.

The promoted-width trap the ticket named is real and pinned:
`(signed char)1 << 8` folds at int width to 256 (a width-8 rule would give
0 in one direction; the old width-64 rule diverged in the other).

Tests: `tests/unit/conformance/ce_shift_fold_promoted_width/` (guard:
clang-verified defined static matrix + 20 const-vs-volatile AGREE rows,
UB rows asserting agreement only — no UB value is pinned) and
`tests/unit/conformance/diag_shift_fold_count_ub/` (the pre-fix
discriminator: `int g = 1 << 32;` compiled at exit 0 before, exit 1 now).

## Evidence identity

830/0/3 baseline → 831/0/3 after #643 (+1) → **833/0/3** after #645 (+2).
Declared to @master before the gate per §3a.2.
