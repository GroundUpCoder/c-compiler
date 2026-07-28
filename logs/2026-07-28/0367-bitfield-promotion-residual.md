# 0367 — every place a bit-field's declared type leaked past the integer promotions

Deep-dive 1 of the 24h review (`logs/2026-07-28/review-24h-overview.md` §6):
the review proved 0356's "unary … already correct" claim false for unary and
asked for the full enumeration. Method: probe C programs per operator family,
clang `-std=c11` native as the oracle vs `compiler.js`+`host.js`, stdout
byte-diffed; every divergent case then re-run on `970aedf1^` (0356's parent)
to separate residual from regression. **All six classes are pre-existing;
0356 regressed nothing.**

## What diverged (all clang-pinned, all now fixed)

1. **Unary `+`/`-`/`~`** (`makeUnary` → `computeUnaryType`): result type came
   from the unpromoted declared type. `-u20 < 0` → 0 (clang 1);
   `(unsigned long long)~u20` zero-extended (clang sign-extends). The
   declared type is irrelevant to the rule: `long long ll20:20` and
   `unsigned u20:20` both promote to `int`.
2. **Ternary**: `computeTernaryType` got the branches' declared types.
   `(c ? u20 : u20) - 0x200000` computed unsigned.
3. **Compound assignment** (`emitAssignment`): the computation type was
   `UAC(declared lhs, declared rhs)`. `u20 /= -3` divided unsigned (quotient
   0; clang -333333 masked = 715243), `%=` likewise, and the rhs-side dual
   `int x /= u20` was also unsigned. Only div/mod/(shift-sign) are
   observable; add/sub/mul wrap identically — the committed test says which
   is which.
4. **Assignment result type**: 0356's `promoteExprType` at the `makeBinary`
   choke promoted the ASSIGN's own left operand, typing `(s.ull20 = 5)` as
   `int` while codegen reloads the stored field at declared 64-bit width —
   `(s.ull20 = 5) - 100` emitted **invalid wasm** (i32.sub over an i64
   reload; the module fails validation, an ICE at compile time). C11
   6.5.16p3: the assignment has the *unpromoted* lvalue type.
5. **Bit-field-ness carriers**: clang tracks the source bit-field through
   assignment results, compound-assignment results, the comma operator's
   last operand, and **pre**-inc/dec — `-(s.u20 = X) < 0` is 1 — but NOT
   through **post**-inc/dec. Both directions pinned
   (`parse_bitfield_promote_carriers` I1–I3).
6. **`sizeof(bf)`**: constraint violation (6.5.3.4p1); we silently returned
   the storage size. Now diagnosed (`diag_sizeof_bitfield`).

## What did NOT diverge, and why (so nobody re-audits blind)

- **Vararg passing** — the 0356 claim was TRUE here, structurally: every va
  slot is 8 bytes (`vaSlotSize` rounds up), so a promoted-int slot and a
  declared-type slot have identical layout and the callee's `va_arg` reads
  the same bytes.
- **Casts / plain assignment / init / non-vararg args** — the loaded register
  value already equals the C value of the field, so converting from the
  declared type and from the promoted type coincide.
- **`switch` scrutinee** — case constants within the field's value range
  compare equally at either width; outside it they match nothing either way.
- **Post-inc/dec, `_Alignof(expr)` (GNU ext, no constraint), `&bf` (already
  diagnosed).**

## The fix shape

One `sourceBitField(e)` walker (member access base case + the carrier forms
above) feeding the existing `promoteExprType`; `makeBinary` excludes the
assignment's left operand from promotion (kills the ICE); `makeUnary`
materializes the promotion as an implicit cast on the operand — that keeps
codegen's operand-driven wasm typing consistent (a narrow field of a 64-bit
declared type promotes to int as i64 load → i32 wrap) instead of adding a
second hand-written rule list, which is how this gap opened; the ternary
call site and `emitAssignment`'s op-type computation promote through the
same helper; `checkSizeofExprOperand` adds the constraint diagnostic.

Test-first: five conformance dirs committed RED in the preceding commit,
green with the fix; the ICE case is the red **by construction** (it cannot
compile pre-fix).

## Blast radius (measured, 0328 method)

28 vendor `bin.json` builds, main-head compiler vs fixed, sha256 per wasm:
**one mover** — micropython **+1 byte**, exactly one function
(`mp_obj_bytes_fromhex`; instruction-level: `i64.extend_i32_s; i64.add` of a
hex-digit value into a 64-bit accumulator becomes `i32.add; i64.extend_i32_s`
— the promotion applying). quake's hash flips run-to-run with size constant
regardless of compiler (`__TIME__` nondeterminism, known) — and it is PROVEN
unmoved at the code level: 0 of 563 function bodies differ between base and
fixed builds; the flip lives entirely in the `__TIME__` data segment.
cpython / tcc /
tinyemu / libgit2 / fakegit are harness-limited in the ad-hoc probe (clang
channel / `--allow-undefined`), same as 0328's run; everything else is
byte-identical. micropython moving means the fat bake's bytes change —
**the master owes the image version bump at merge** (image.json deliberately
untouched on this branch).

## Gates

`unit` 791 passed / 0 failed (+5 new conformance dirs; 1 unrelated xfail,
3 skipped), `host` ok, `blockfs` 15/15, `todos` ok (after retiring L53),
`kernel` 124/124, and — because `0362` means the diff-scoped gate cannot see
them for a compiler.js change — `micropython` + `micropython-upstream` by
hand: **584 passed, 0 failed, 65 skipped** (R2 baseline was 580/65; no
regression, zero failures). The byte-identical vendors (lua, sqlite, …) need
no corpus re-run: byte-identity is a stronger statement than a green suite.

## Gotchas worth keeping

- The ICE class hides in plain sight: it needs a ≤32-wide field of a 64-bit
  declared type whose *assignment result* is consumed arithmetically —
  rare in C as written by humans, which is why four vendor corpora never hit
  it. The conformance dir now pins it.
- clang's carrier set is asymmetric (pre-inc carries, post-inc doesn't).
  Don't "fix" that symmetry: it's pinned behavior, and the standard's text
  underdetermines it — matching the oracle is the policy.
- An ad-hoc `buildProject` probe must sit next to `libc-ext.js` or busybox
  fails with missing `glob.h`/`fnmatch.h` — a probe artifact that looks
  exactly like a real regression until you read the error.
