# #680 — real `__builtin_bswap16/32/64` (macro double-evaluation fix)

**Classification: `contract-violation`** (GCC documents these as builtin
functions; a function call evaluates its argument exactly once). Epic:
gamedev — the builtins landed for the mGBA port; a silently wrong result
under a compiler-reserved name sits on the game-porting path.

## Measured before the change (base `69b6c1f1`, real cc driver over MemoryByteStore)

`__builtin_bswap32(i++)` left `i == 4`; the 16/64-bit forms left 2 and 8.
Worse: with a side-effecting argument the macro's *value* is also wrong —
`__builtin_bswap16(i++)` with `i` starting 0 returned 256, because different
substitution slots read different `i` values mid-swap. Effect-free arguments
returned correct values, and constant arguments folded in ICE contexts (array
bound compiled) — both capabilities the fix had to preserve.

## Shape

The macros were the wrong seam; the right one already existed —
`__builtin_expect`/`__builtin_constant_p` are lexer keywords parsed into the
compiler. The fix mirrors that exactly:

- **Lexer**: three new keywords (`X_BUILTIN_BSWAP16/32/64`). Keyword
  resolution runs *after* the preprocessor, so SameBoy's
  `#define __builtin_bswap16 __sameboy_bswap16` shim still defines and
  expands (verified: shadow + `#undef` restore both work).
- **Parser**: `parseBswap` → `EIntrinsic` with `IntrinsicKind.BSWAP16/32/64`;
  result types `unsigned short`/`unsigned int`/`unsigned long long` (GCC's
  uintN_t signatures); non-arithmetic arguments are a parse error.
- **ConstEval**: `constEvalItem` gained an `EIntrinsic` case — operand
  funnels through `ConstEval.convert` (the single C11 6.3.1 implementation)
  then byte-swaps. This is what keeps enum values, array bounds and case
  labels folding.
- **Static initializers**: the codegen-side `constEvalExpr` evaluator is a
  *separate* evaluator (address-aware) and did NOT see the fold — the first
  probe regressed `unsigned g = __builtin_bswap32(K);` at file scope. Fixed
  by delegating its new `EIntrinsic` case to `constEvalItem`, so the two
  evaluators cannot disagree.
- **Codegen**: wasm has no bswap opcode; the argument is emitted ONCE,
  converted to the unsigned result type (`emitConversion` masks/extends),
  teed into a scoped temp local, then shifts+masks+ors. i32 for 16/32-bit,
  i64 for 64-bit.
- **Prelude**: the three macros DELETED in the same change (two-sided edit
  per PRINCIPLES.md), with a comment forbidding their return.

## Evidence

- Probe (cc driver): before `main() = 428` (i left 4/2/8), after `111`
  (1/1/1). Probe 2 (runtime/codegen path): volatile operands at all three
  widths, wide-int→u16 truncation, negative int→u32/u64 sign-extension,
  double→u32 conversion, static u32+u64 initializers, enum ICE, case-label
  ICE — all pass.
- Conformance test `builtin_bswap_single_eval` committed RED first
  (`e2d5970c`, test-first): on the macro compiler it fails
  `evals 2 4 8` / corrupted zero-leg values; green after the fix. Its
  run/conv/ice legs pass on BOTH — they pin the preserved capabilities.
- `#if` PP contexts: no vendor code uses `__builtin_bswap*` directly in
  `#if` (only behind `__has_builtin`, which is undefined and stays so —
  out of scope per the ticket; noted: those guards keep falling through to
  fallbacks, unchanged).

## Adjacent, not absorbed

`__has_builtin` remains undefined (separate feature gap, per ticket). The
`__builtin_clz/ctz` family stays macro-shaped — single substitution each,
no double-evaluation, and `__wasm` needs the macro form's type argument.
