# 0356 — three red MicroPython float tests were one compiler miscompile

The ticket described three red files in `micropython-upstream`
(`builtin_float_round.py`, `math_domain.py`, `math_fun_int.py`) and told me not
to assume they were one fix or three. They were one fix, and it was not in
`vendor/micropython/` at all.

## The chain

Every one of the three diffs is the same substitution: where CPython raises
`ValueError` on a NaN, we raised `OverflowError`.

```
ceil(inf) = OverflowError   ← matches
ceil(nan) = OverflowError   ← want ValueError
```

That pairing is the tell. `Inf` and `NaN` are the two branches of one `if` in
`py/objint.c`:

```c
mp_obj_t mp_obj_new_int_from_float(mp_float_t val) {
    mp_float_union_t u = {val};
    if (u.p.exp == ((1 << MP_FLOAT_EXP_BITS) - 1)) {
        if (u.p.frc == 0) {
            mp_raise_msg(&mp_type_OverflowError, ...);   // inf
        } else {
            mp_raise_ValueError(...);                    // nan
        }
```

So NaN was taking the Inf branch: `u.p.frc == 0` was true for a non-zero
fraction. MicroPython classifies IEEE-754 by hand through a bit-field union
rather than `fpclassify` (we ship no `fpclassify`, which is why this path is
load-bearing here and nowhere else), and with `MICROPY_FLOAT_IMPL_DOUBLE` the
field is `uint64_t frc : 52`.

Minimal repro, ours vs clang:

```c
union { double f; struct { uint64_t frc:52, exp:11, sgn:1; } p; uint64_t i; } c;
c.f = 1.5;
printf("%llx\n", (unsigned long long)c.p.frc);   // 8000000000000 — both
printf("%d\n",   c.p.frc == 0);                  // ours 1, clang 0
```

The *value* was right; the *comparison* was wrong. That narrows it to the
operand's type, not the load — and `emitBitFieldLoad` was indeed already
emitting a correct i64 for an 8-byte unit.

## The bug

`promoteExprType` collapsed **every** bit-field to `int`/`unsigned int`:

```js
if (isSigned || bw < 32) return Types.TINT;
return Types.TUINT;
```

C11 6.3.1.1p2 only promotes a bit-field when `int`/`unsigned int` can represent
its values *as restricted by the width*; anything wider is one of the "all other
types [that] are unchanged". A 52-bit field is wider than `int`, so it keeps
`uint64_t` — but we handed the binary operator a `TUINT`, codegen wrapped the
i64 to i32, and the fraction's high 20 bits went out the window. Every NaN's low
32 fraction bits are zero in the common quiet-NaN encoding, so `frc == 0`.

Only the **binary** operand path routes through `promoteExprType`. That is why
`!c.p.frc` gave the right answer while `c.p.frc == 0` did not, and why the printf
in the repro above disagreed with the comparison two lines below it.

> 🔴 **ERRATUM (master cont-121, 2026-07-28).** This paragraph originally read
> *"Unary, ternary and vararg operands were already correct."* **That is FALSE for
> unary, and the commit message of `970aedf1` carries the same false sentence
> (immutable — this note is its erratum).** `buildUnary` computes its result type
> from the **unpromoted declared type**, so a bit-field narrower than `int` never
> takes the C11 §6.3.1.1p2 integer promotion. Reproduced against clang: for
> `unsigned int u20:20` holding 1, `-s.u20` prints `-1` in both, but
> `(-s.u20) < 0` is **0** for us and **1** for clang. Filed as **`todos/0367`**
> (P0) with register entry **`L53`**; ternary and vararg are unaudited and are in
> that ticket's scope. **Not a 0356 regression — pre-existing on the parent.**
> The lesson: this sentence did not merely record a gap, it asserted the gap was
> *closed*, which is what stopped anyone looking for four merges.
>
> **Audit completed (0367 lane, same day).** The deferred halves of the sentence
> resolve: **ternary was ALSO false** — `computeTernaryType` received the
> branches' declared types, so `(c ? u20 : u20) - 0x200000 < 0` was 0 for us,
> 1 for clang. **Vararg was TRUE** — every va slot is 8 bytes (`vaSlotSize`),
> so the promoted-vs-declared slot layout is indistinguishable by construction.
> The full enumeration (six divergence classes, including a pre-existing ICE on
> `(s.ull20 = x) - y` and the compound-assign signedness miscompile
> `u20 /= -3`) and the fix live in `todos/0367` and
> `logs/2026-07-28/0367-bitfield-promotion-residual.md`.

The signedness test moved to `!uq.isUnsigned()` in the same edit. The old
identity list (`TINT || TLONG || TSHORT || TSCHAR || TCHAR`) omitted
`long long`, so a 32-bit-wide `int64_t` field promoted to `unsigned int` and
`s.s32 < 0` was false. Same defect family: a declared type wider than `int`.

Verified against clang, which promotes exactly: `bw < 32` → `int`, `bw == 32` →
`int` if signed else `unsigned int`, `bw > 32` → declared type.

## What this says about the gate

The bug was live on `origin/main` with `node tests/run.js unit` **green**. The
only thing in the estate that caught it was `micropython-upstream` — and
`tests/run.js`'s `^compiler\.js$` rule does not select any `run.py` category
but `unit`. So `--diff` on the commit that introduced this would have gone
green while claiming "the compiler drives every wasm binary".

Filed as **todos/0362** with register entry **L50**, and the rule now carries a
`NOT SELECTED YET:` comment naming the exclusion. This is the 0318 lesson in a
different costume: there a catch-all hid under-scheduling silently; here a
rationale string overstates its own list, which is worse, because it reads as a
considered scope decision rather than an omission.

## Notes

- Nothing was skipped. The three files pass on the fix; no
  `vendor/micropython/README.md` gap entry was owed.
- `basics/set_binop.py` timed out once during the first full acceptance run
  (15s per-test cap) and passed in isolation and on a clean re-run — that
  category took 71.4s under load vs 53.7s idle, with another lane's kernel
  suite on the box. Recorded as an observation, not filed: one occurrence,
  under acknowledged contention.
- `vendor/micropython` was not touched, so no package republish is implied by
  this lane's diff. `compiler.js` changed, which restales every baked binary —
  the image-version call is the master's.
