# 0367 — a unary operator on a bit-field keeps the unpromoted declared type, so -bf/~bf miscompile against clang

- **Status**: open
- **Design**: —

## Goal

`0356` fixed the **binary** operand path: `promoteExprType` used to collapse every
bit-field to `int`/`unsigned int`, so a field wider than `int` was truncated. The
**unary** path was never fixed, and — this is the part that matters — `0356`'s
commit message (`970aedf1`) and dev log (`logs/2026-07-28/0356-bitfield-wide-promote.md:68`)
both state that it **did not need to be**:

> "Unary, ternary and vararg operands never routed through `promoteExprType` and
> were already correct."

**That claim is false for unary, and it is the reason this ticket is P0.** A wrong
comment is cheaper than a wrong comment that says "already checked" — the latter
stops the next person from looking. See lesson *"a TRUE comment naming an
unclosed gap is more dangerous than a false one"*: this is its sharper cousin, a
**false comment claiming the gap is closed**.

## The mechanism

`buildUnary` (`compiler.js`, the `return new EUnary(...)` at ~5399) computes the
result type as `Types.computeUnaryType(op, operand.type)` — where `operand.type`
is the **declared** type, still carrying the bit-field's width and signedness. C11
§6.3.1.1p2 requires the integer promotions first: a bit-field narrower than `int`
promotes to **`int`** (signed), because `int` can represent all its values.

## Reproduced by master cont-121 (independent of the review that reported it)

```c
struct S { unsigned int u20 : 20; };
struct S s; s.u20 = 1;
printf("neg=%d\n", -s.u20);
printf("neg_is_neg=%d\n", (-s.u20) < 0);
```

| | ours | clang `-w` (oracle) |
|---|---|---|
| `neg` | `-1` | `-1` |
| `not` | `-2` | `-2` |
| **`(-s.u20) < 0`** | **`0`** | **`1`** |

Commands: `node compiler.js /tmp/bf5/u.c -o /tmp/bf5/u.wasm && node host.js /tmp/bf5/u.wasm`
versus `clang -w -o /tmp/bf5/u.native /tmp/bf5/u.c && /tmp/bf5/u.native`.

⭐ **Note the signature — it is EXACTLY 0356's.** The *value* prints correctly and
the *comparison two lines down* disagrees. That is what localises it to the
operand's type rather than to the bit-field load, and it is why a test that only
prints values will pass over this bug forever.

**Pre-existing, NOT a 0356 regression** — reproduces on `970aedf1`'s parent too.

## Plan

1. Promote in `buildUnary` before computing the result type: apply the integer
   promotions to a bit-field operand (`bw < 32` ⇒ `int`; `bw > 32` keeps the
   declared type, mirroring 0356's rule in `promoteExprType`). Prefer **one shared
   promotion helper** over a second hand-written rule list — a parallel list is how
   this gap opened.
2. Audit the other two paths the false claim also covers — **ternary** and
   **vararg** — the same way, with clang as the oracle. `0356`'s review verified
   ternary clang-identical for the *binary* fix; that is not the same question as
   whether the unary/promotion seam reaches them. **Do not inherit the claim you
   are here to disprove.**
3. Correct the historical record: the false sentence in the `0356` dev log is
   amended in the same commit that files this ticket (the commit message of
   `970aedf1` is immutable — this ticket is its erratum).

## Acceptance

- A conformance test under `tests/unit/conformance/` encoding the **property**
  (unary on a narrow bit-field promotes to signed `int`), not a MicroPython proxy
  — and asserting the **comparison**, not just the printed value.
- **Positive control, both directions, with literal output:** the test is RED on
  the pre-fix compiler and GREEN after. A scan or a fix without a positive control
  is not evidence.
- clang used as the oracle for every case in the table, signed and unsigned, at
  widths straddling 32.
- Blast radius **measured, not asserted** — say how many baked binaries change
  bytes. If any do, the master owes an image bump; **do not touch `os/image.json`
  yourself**.
- ⚠️ Gate note: `0362`/`L50` proves a `compiler.js` edit selects **no `run.py`
  category but `unit`**. Until `0362` lands, **run `micropython`,
  `micropython-upstream` and the vendor corpora by hand** — the diff-scoped gate
  structurally cannot see the corpora where this class of bug lives.

## Enumeration + fix (branch `0356-unary-residual`, review deep-dive 1)

Every site that consumes a bit-field's declared type was enumerated and
clang-pinned (probe method: one C program per family, clang `-std=c11` native
vs `compiler.js` + `host.js`, byte-diffed stdout). Six divergence classes,
**all pre-existing** (each reproduced on `970aedf1^` too):

| # | site | shape | clang | ours (pre-fix) |
|---|------|-------|-------|----------------|
| 1 | `makeUnary`/`computeUnaryType` | `-u20 < 0` | 1 | 0 |
| 2 | ternary branch types | `(c ? u20 : u20) - 0x200000 < 0` | 1 | 0 |
| 3 | compound-assign compute type (both sides) | `u20 /= -3`; `int x /= u20` | signed div | unsigned div |
| 4 | assignment result type | `(ull20 = 5) - 100` | int -95 | **ICE — invalid wasm** |
| 5 | bit-field-ness carriers | `-(u20 = X)`, `-(0, u20)`, `-(++u20)` | promoted | unpromoted |
| 6 | `sizeof(bf)` | constraint 6.5.3.4p1 | error | silently 4 |

Carrier pins (clang): assignment/compound results, comma's last operand and
**pre**-inc/dec carry the source bit-field; **post**-inc/dec do NOT.

Verified NOT divergent (and why): explicit casts + plain assignment/init/arg
conversions (the loaded register value already equals the C value, so
conversion-from-declared ≡ conversion-from-promoted), **vararg passing** (every
va slot is 8-byte — `vaSlotSize` — so int-vs-declared slot layout is
identical; the 0356 claim was TRUE for vararg), post-inc/dec, `switch`
scrutinee (case constants in the field's value range compare equally at either
width — unobservable), shift/binary/comparison operands (0356's fix),
`_Alignof(expr)` (GNU extension, no constraint), `&bf` (already diagnosed).

Fix (one commit with this note): `sourceBitField` walker + `promoteExprType`
over it; assignment result type excluded from promotion (6.5.16p3) — kills the
ICE; unary +/-/~ promote the operand via materialized implicit cast;
ternary promotes branch types; `emitAssignment` computes compound ops in
`UAC(promoted lhs, promoted rhs)`; `checkSizeofExprOperand` diagnoses
`sizeof(bf)`. Tests: five conformance dirs committed RED first
(`parse_bitfield_{unary,ternary,compound_assign}_promote`,
`parse_bitfield_promote_carriers`, `diag_sizeof_bitfield`), green after.

Blast radius, measured over the 28-project vendor corpus (0328 method,
base = main head vs fixed): **micropython is the only mover** — +1 byte,
one function (`mp_obj_bytes_fromhex`: an i64 add of a sign-extended int
became an int add then extend, i.e. the promotion applying); quake differs
run-to-run regardless (`__TIME__`, known) and is proven unmoved at the code
level (0 of 563 function bodies differ); busybox/lua/sqlite/doom/sameboy/
winmine/notepad/calc/sent/magicpoint/gameboy/snake/hello + the rest:
byte-identical. cpython/tcc/tinyemu/libgit2/fakegit are harness-limited in
the ad-hoc probe (clang channel / `--allow-undefined`), unchanged from 0328's
run. micropython moving means the fat bake changes: **master owes the
version bump at merge** (image.json untouched here per the acceptance).

L53 retired in the same commit (anchor comment replaced by the fix).
Master: close this ticket when merging the branch.
