# CD17 — the C-op → wasm ALU opcode table existed twice; now one (todos/0247)

## What

The op → `body.aop(opcode, signedness)` mapping was written twice in
compiler.js, differing only by the `_ASSIGN` suffix: `emitCompoundOp` (for
`x += y` … `x >>= y`) and the `emitExpr` EBinary switch (for `x + y` plus
the compares). The signedness decisions — DIV/MOD and the compares passing
`!isUnsigned` as aop's flag, SHR selecting `OP_SHR_U`/`OP_SHR_S` explicitly
— lived in both, so a signedness fix could land in one table and miss the
compound twin (the 02xx drift-bug class the conformance hunt kept hitting).
A third site, sema's `typesAreOperandCompatible`, derived the base op its
own way (`op.replace("_ASSIGN","")`).

Now there is ONE table and ONE base-op derivation:

- `CodeGenerator.emitBinaryAluOp(op, wt, isUnsigned)` — the sole place a C
  binary op picks an ALU opcode (arithmetic, bitwise, shifts, AND the
  compares; unknown op throws instead of silently emitting nothing).
  `emitCompoundOp` is deleted; its lone caller in `emitAssignment` and the
  EBinary switch both call the helper.
- `AST.baseOpOfCompound(op)` — the one `_ASSIGN` stripper, used by the
  compound-emit path and by `typesAreOperandCompatible`'s compound-assign
  recursion. It's exported from the AST module because sema and codegen
  live in separate IIFE closures (first attempt referenced it bare from the
  emitter and got a runtime ReferenceError — the file's column-0 formatting
  hides the closure nesting; `AST.pointerArithElemType` was the precedent).

## SHR stays explicit, deliberately

The task of unifying exposed the tables' internal inconsistency: DIV/MOD
pass signedness as `aop`'s flag while SHR picks the `_U`/`_S` opcode
constant itself. Checked before assuming: `ALU` has NO plain `OP_SHR` —
only `OP_SHR_S`/`OP_SHR_U` as distinct constants, and neither `getaop` nor
the WAST `WAop` node has an OP_SHR+sign path. Unifying onto a flag form
would mean *adding* mechanism to the opcode layer for zero behavior change;
one table is the win, so SHR keeps the explicit pair (noted in the helper's
comment).

## Proof it's pure

- SameBoy interlock: `vendor/sameboy/bin.json` built via
  `os-common.buildProject` with the HEAD compiler vs the patched one —
  byte-for-byte identical (same SHA-256), i.e. the two tables really did
  agree on every op.
- Full gate foreground: unit (incl. the conformance signed/unsigned
  DIV/MOD/SHR/compare corpus) + ast + host + blockfs + kernel all green.
- Byte-identical codegen → no image bake, no image.json bump; no os/ C,
  host.js, or kernel.js touched.
