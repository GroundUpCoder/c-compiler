# P0 fixes from the fresh-eyes bug hunt (todos/0203–0209)

The 2026-07 read-only fresh-eyes hunt over compiler.js surfaced 8 P0
correctness items; all landed today, each test-first (failing regression
committed with its fix), each gated on the full estate (unit + blockfs +
host + all run.py categories + kernel 73/73 + mkimage bake;
micropython-upstream stayed at its same 3 pre-existing float failures
throughout — builtin_float_round / math_domain / math_fun_int, verified
per-run).

## G1 — `++`/`--` on `void *` was a stride-0 no-op (0203, d8f16cd)

`emitIncDec` computed the pointer delta with raw `sizeOf(baseType)` (0
for void) while `p+1`/`p+=1` already went through the `ptrArithElemSize`
stride-1 clamp — so mixed code silently walked wrong. One-line fix:
route inc/dec through the same clamp. `void_ptr_incdec` pins all four
operators. NB the related `sizeof(void)==0` root (hunt G21) is NOT
addressed — the clamp fixes arithmetic without touching sizeof
semantics; G21 stays in the later batch.

## G2 — tentative `int arr2[];` sized 0 bytes; next global overlapped (0204, 7b0810f)

C11 6.9.2p2 end-of-TU completion (incomplete tentative array → one
element, zero-init) simply didn't exist, so `allocateStatic` got size 0
and the next global landed at the same address. The completion pass runs
in `linkTranslationUnits` AFTER definition merge — deliberately, so an
initialized (size-bearing) definition from any TU has already won and
only still-tentative winners complete to `[1]`. `tentative_array` probes
extern + static flavors with adjacent-global guards.

## G3 — automatic-storage FAM initializer clobbered the frame (0205, 4132f89)

A local `struct FAM f = {1,{2,3}}` was accepted (gcc/clang reject) and
the FAM element stores ran past the plain-`sizeOf` frame slot — the
repro's printf output vanished entirely. Chose the conformant option:
REJECT (recoverable parse error) for non-STATIC objects, via the new
`initListInitializesFAM` helper mirroring `computeFAMExtraSize`'s
non-zero condition. Static/file-scope FAM init (sized via
`computeInitAllocSize` — block-scope statics flow through the
definedVariables allocation path, which is why they were never broken)
stays supported and is pinned by `fam_init_ok`.

## G4+G5 — string-literal aggregate init under IRREDUCIBLE_LOWERING (0206, c33f5f4)

One root, two symptoms in `emitAggregateInitAssigns` (the decl-hoist
rewrite): (a) a brace-wrapped string — the `EInitList{char[N],[EString]}`
shape `normalizeInitList` deliberately keeps per C11 6.7.9p14 — fell to
the scalar-leaf fallback as `B[0] = <string>` and stored the literal's
ADDRESS low byte; (b) the EString per-element store loop indexed the
literal's little-endian BYTES by ELEMENT index, interleaving NULs into
`char16_t[] = u"XY"`. Fixes: recognize the brace-wrapped shape as a
whole-array fill; decode element-sized LE units. `lowered_string_agg_init`
pins both via config `compilerArgs: ["--force-dispatch-loop"]` (the
natural trigger is irreducible control flow, which a test shouldn't
depend on constructing).

## G6 — const-eval evaluated both sides of `&&`/`||` (0207, 839796f)

`constEvalItem`'s EBinary case was eager (the ternary case was already
lazy): `enum { C1 = 1 || 1/0 }` failed the eval and silently fell back
to the running enum counter (C1 == 0 — a miscompile with no diagnostic);
the same root rejected valid `case (1 || 1/0)+1:` and `int a[1 || 1/0];`.
Short-circuit added per C11 6.6p3; and a failed enumerator const-eval now
diagnoses (6.7.2.2p2 constraint) instead of taking the counter.
Note clang agrees that `-1 && 0/0` is NOT a valid ICE (the division IS
evaluated) — kept that shape out of the positive test.

## G7 — alloca inside a variadic argument corrupted the arg block (0208, c42918d)

`printf("arg %d\n", use(5))` with an alloca-using `use` printed NOTHING.
Diagnosis: after each variadic arg store the emitter RECOMPUTED
`argBlockBase = SP + <tracked struct-ret deferred delta>`; a callee that
used alloca() returns with an UNTRACKED retained SP bump (the
caller-frees contract — alloca() is a wrapper function returning the
intrinsic's bump to ITS caller), so the base shifted down by the alloca
amount and the callee got a garbage block pointer.

Fix has two halves, both sites (direct + indirect):
- `argBlockBase` stays FIXED — the block never moves, and per-arg store
  addresses were already pushed before each argument's evaluation, so
  the recompute was a no-op in every tracked case and only ever WRONG.
- The post-call SP release is now CONDITIONAL (`emitVaBlockRelease`):
  restore `SP = base + blockSize` only when SP sits exactly at
  `base - <tracked delta>`; on mismatch an alloca region lives below the
  block, so leave SP alone — block + temps leak until the function
  epilogue, which is the alloca contract's designated free point. The
  trade (transient stack growth in alloca-in-arg expressions) buys
  correctness; anything cheaper would free live alloca memory.

## W1 — inliner local growth unbudgeted → latent 50k-local ICE (0209)

The WAST inliner budgeted only real body nodes; each inlined site also
adds k params + ALL the callee's declared locals, unchecked against
wasm's 50,000-local engine limit ("local count too large" at
WebAssembly.Module — no compiler-side guard existed). New `localCap`
budget (default 45000): a site whose projected caller local count would
cross it is refused (`budgetLocals` bucket). Measured on ext_regex:
max-locals-per-function grows 175 (default caps) → 37,694 (unbounded
caps) — the hunt's exact ICE (12.5k-local callee × 4 sites) did NOT
reproduce on this tree at any cap setting, but 37.7k is one admission
short of the cliff and the guard is the prerequisite for the 0201
deferred big-callee unlock. Interlock held: default-cap ext_regex output
byte-identical pre/post (90103 B, 282 inlined, same refusals),
tests/bench sum OK. Regression tests: `refuse-budgetLocals` +
`budget-locals-accumulates` in tests/ast/test_wast_inline.js (fail
pre-fix, pass post-fix).

## Process notes

- Every fix verified against clang on the same source before goldening.
- The `queue.js done` git-mv fallback ("stage it yourself") fired on
  every close — remember to `git add todos/done/NNNN-*.md`.
- Suite timing on this machine: unit ~13s, blockfs ~90s, host ~117s,
  run.py batch ~280s, kernel ~470s, bake ~25s.
