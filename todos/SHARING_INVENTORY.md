# Translator Sharing Inventory

Audit of duplicated/specialized translation logic between the default
backend (`CodeGenerator`, ~line 8735+) and the GUC backend (`Translator`,
~line 11800+).

## Already module-scope (default-backend authoring; GUC should USE not duplicate)

| Item | Line | Status |
|---|---|---|
| `isStructOrUnion(type)` | 8521 | duplicated logic in GUC's `_isStructOrUnion` (currently absent — was in Phase that got reverted; needs to USE the shared one when re-introduced) |
| `cToWasmType(type, wmod)` | 8525 | NOT shareable as-is — output type differs (`WT_*` vs guc `T.*`). Sharing the SHAPE (the dispatch on `type.kind`) is possible but requires abstraction. |
| `gcStorageTypeOf(wmod, t)` | 8540 | default-specific (uses `wmod`); GUC has its own equivalent baked into `_resolveGCStructType`. Sharing the SHAPE is possible. |
| `isSignedSubI32(t)` | 8566 | shareable; GUC backend currently doesn't use this. |
| `isPackedSubI32(t)` | 8570 | shareable; GUC backend currently doesn't use this. |
| `vaSlotSize(type)` | 8717 | **DUPLICATED** in GUC's `_vaSlotSize` (line 12002). Should use shared. |

## Default-backend-only that SHOULD be shared (GUC reimplements badly)

| Item | Default line | GUC line | Notes |
|---|---|---|---|
| `_constEvalExpr` (full constant evaluator: int/float/addr; casts, unary, binary, ternary, sizeof, member, subscript) | 8990 | partial (`_evalConstInit` at 14717 — INT/FLOAT/CAST/NEG only) | **High-priority share.** This is why `~0U`, `BinOp` on constants, sizeof in init, etc. fail in GUC. |
| `_constEvalAddr` (constant address evaluation: `&x`, `&arr[N]`, `&s.field`, casts) | 8958 | partial (my `_addressIRForAddrOf`, `_tryStaticAddrLike` — only `&ident`, `& ident + N`) | Default returns `{kind: 'addr', addrVal: number}`; GUC needs IR expressions. **Sharing requires abstracting the leaf representation** (variable→address). |
| `writeConstValueToStatic` (encode int/float/addr to LE bytes) | 8913 | `_writeScalarBytes` (14661) | Both implementations — could share. |
| `writeStringLiteralToStatic` (string into char-array static) | 8950 | inline in `_writeStaticInit` | Could share. |
| Static init-list traversal (struct/union member walk, array element walk, designators) | scattered around 9215+ | `_writeStaticInitList` (14632) | Same algorithm — both walk `initList.elements` against type members. Could share, parameterized by "evaluator+writer" callbacks. |
| Bitfield init writing | scattered around 9264 | not done in GUC | bit-level shift+mask insert. Algorithmic, sharable. |

## Default-backend-only — GUC has CLEANER abstraction; do NOT share

These are concepts where the GUC backend's design is structurally different
(and arguably better) so sharing would force the GUC backend to mimic
default's stream-emitter shape.

| Item | Default approach | GUC approach | Why not shared |
|---|---|---|---|
| Stack frame prologue/epilogue | Explicit `__stack_pointer` global manipulation by frontend; manual `savedSpLocalIdx`, `frameSize`. | Frontend declares `IR.StackSlot`s; codegen owns layout, prologue, return-restoration. | GUC's design is cleaner. Sharing would force GUC frontend to manually manage SP, defeating the abstraction. |
| Variadic call frame | Frontend manually decrements/restores `sp` around each variadic call. | Per-call `IR.StackSlot` of size blockSize; codegen lays out + colors. | Same reason. |
| Indirect function call table | Frontend manages `funcDefToTableIdx` map; explicit `ElementSegment` setup. | `IR.FuncIndex(f)` bubbles up; codegen synthesizes auto-table. | GUC's bubble-up is structurally simpler. |
| Static data layout | Frontend builds one big `staticData` Uint8Array as it walks; addresses baked in. | `IR.MutableBytes` identities + `IR.layoutAndSubstitute` pass; addresses resolved at codegen. | GUC's design supports init exprs referencing `&otherGlobal` cleanly; default's "everything addressable at translation time" model can't. |
| Exception handling | Manual `try_table` emission with depth tracking + savedSp/restore. | High-level `IR.TryCatch` lowered by `lowerTryCatch`; auto-injects `RestoreStackToPostPrologue`. | GUC's lowering is centralized; sharing would lose that. |
| Block/loop/if/try control flow | Stream-emit `block()`/`loop()`/`end()` with depth-relative `br N`. | Tree-shape `IR.Block(label, body)` with symbol-based `IR.Break(label)`. | Fundamentally different paradigms (stream vs tree). |
| Function-body emission | Direct byte-stream into `WasmCode`. | Build immutable `IR.Expression` tree; codegen serializes later. | Same — fundamentally different paradigm. |

## Default-backend-only — should be shared, but tricky

| Item | Default line | Notes |
|---|---|---|
| `_constEvalAddr` | 8958 | Returns `{kind: 'addr', addrVal: number}` — number form only makes sense for default (translation-time addresses). For GUC, we need to abstract the leaf (variable identity, function identity, heap base) so each backend resolves it differently. Doable as a parameterized walker. |
| Goto label depth tracking | `walkSwitch`, `walkCompound` in `lowerGotosInFunc` | Already shared (Parser.lowerGotos). Default backend uses `brDepth` annotation; GUC has its own `gotoLabelToSym` symbol map. The DEPTH-COMPUTATION is shared via the linter pass; the EMIT differs per backend. OK. |
| Numeric conversion logic (`emitImplicitCast`, etc.) | scattered | Default has mature handling; GUC has a partial reimplementation. Sharing the *decision logic* (which conversion is needed) is feasible; the *emit* differs (byte vs IR node). |
| Compound assignment integer promotion | scattered | Same shape — decide promotion type, emit ops. Decision logic shareable. |
| Struct ABI (hidden ret-pointer, copy-on-entry params) | line 8729+, 9522+, 9794+ | The ABI DECISION (`isStructOrUnion(retType)` → hidden param) is shareable. The emit differs. |
| Recursive call cycle resolution | line 7492+ (linter) | The depth-mirror algorithm is in the LINTER (already shared). Each backend mirrors it for its own use. |

## Plan

Phase A (this branch): factor out the high-priority **shareable purely-data
helpers** that need no abstraction:

1. ✅ Make GUC backend USE the existing module-scope `vaSlotSize`
   (delete the GUC duplicate). `isStructOrUnion`, `isPackedSubI32`,
   `isSignedSubI32` are exported and available; GUC will pick them up
   as call sites are touched.
2. ✅ Move `_constEvalExpr` / `_constEvalAddr` to module scope. They
   accept a `policy` argument with four address-leaf callbacks:
   `getStringAddr`, `getGlobalAddr`, `getFuncAddr`, `getCompoundLitAddr`.
   The default backend supplies a policy that returns concrete numbers
   (translation-time-known addresses). The GUC backend originally used
   `NULL_ADDR_POLICY` (every address leaf returns null) and later upgraded
   to a per-Translator pseudo-tag policy: every storage identity gets a
   unique numeric tag, so address ARITHMETIC that produces an integer
   (offsetof, ptrdiff, address comparisons) computes correctly while
   address-typed results fall through to the deferred-IR path.
3. ✅ Replaced GUC's anemic `_evalConstInit` with a thin wrapper around
   the shared evaluator.

### Additional fixes layered on Phase A in this branch

- BigInt → IR.Literal range normalization (so `~0U` / inverted bitfield
  masks fit signed slots).
- Static locals (collect into `_collectGlobals` like default's
  `staticLocals` walk).
- File-scope compound literals (one MutableBytes per literal, integrated
  with the deferred-IR address path).
- Bitfield mask sign-extension (re-uses normalize helper).
- ENUM tag in `_loadOp`/`_storeOp`; ENUM_CONST identifier translates to
  literal value.
- Init-list scalar element conversion (e.g. `double a[2] = {42, 23}`
  no longer fails f64.store validation).
- Missing `main` error matches default backend's behavior.
- Boolean `isConst` property access fix.
- i32-narrow i64 indices in pointer arithmetic (SUBSCRIPT, ADD/SUB,
  compound assignment).

**GUC parity: 256 → 287 (+31). Default backend: 420/420 (no regression).**

Phase B (later): factor out the static init-list traversal and bitfield
algorithms.

Phase C (much later): factor numeric conversion / compound-assignment
decision logic.

### Remaining failures (133 tests) — what's blocking them

- **~20 structs**: full struct ABI (hidden return pointer, copy-on-entry
  by-value parameters, struct-as-vararg, large struct copies). Per
  inventory, this is in the "GUC has CLEANER abstraction; do NOT share"
  bucket — the GUC frontend needs its own implementation built on
  `IR.MemoryCopy` + StackSlot, NOT the default backend's stream-emitter
  hidden-pointer pattern. Substantial separate work.
- **Stack slot lifetime / coloring bugs**: many tests with the pattern
  `T1 a = {...}; T2 b = {...}; printf(...)` show `a` and `b` aliasing.
  This is a codegen-side coalescing issue in the GUC `_emitInitListStores`
  / StackSlot lifetime tracking, not a sharing question.
- **Compound-assignment integer promotion**: `unsigned char x; x /= y;`
  needs to promote both to int (signed) before the op. Default backend
  does this in `emitAssignment` via `usualArithmeticConversions`; GUC
  picks signedness from the LHS IR type, giving `div_u` instead of
  `div_s`. Needs an IR-level reinterpret-as-signed mechanism (or a
  whole compound-assignment lowering).
- **Goto + switch lowering edge cases**, **scanf / wchar / time stdlib
  runtime bits**, and various smaller per-test issues.

Each phase is self-contained — committable independently. No phase
should regress parity.
