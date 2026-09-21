# 0247 — CD17 — one C-op → wasm ALU opcode table (compound + binary + sema base-op derivation)

- **Status**: done (2026-07-17) — ONE `emitBinaryAluOp(op, wt, isUnsigned)`
  opcode+signedness table in CodeGenerator (arithmetic, bitwise, shifts,
  compares; loud default on unknown op) + ONE `AST.baseOpOfCompound(op)`
  _ASSIGN stripper; `emitCompoundOp` deleted (its lone caller in
  `emitAssignment` now routes `baseOpOfCompound(op)` through the shared
  table), the EBinary opcode switch folded into the same call, and sema's
  `typesAreOperandCompatible` compound-assign recursion uses the helper
  instead of its own `op.replace("_ASSIGN","")`. SameBoy byte-identical
  interlock: same SHA-256 pre/post; unit+ast+host+blockfs+kernel green.
- **Design**: —

## Goal

Close code-debt scan CD17 (2026-07-17): the op → `body.aop(...)`
opcode/signedness mapping existed TWICE — `emitCompoundOp` (compound
assigns, `_ASSIGN`-suffixed cases) and the `emitExpr` EBinary switch (plain
binaries + compares) — with a THIRD ad-hoc base-op derivation in sema
(`op.replace("_ASSIGN","")` in `typesAreOperandCompatible`). The signedness
logic (DIV/MOD/SHR/compares keying off `!isUnsigned`) was encoded in two
places, so a signedness fix could land in one and miss the compound twin —
the 02xx drift-bug class.

## Plan

- Extract the EBinary switch body as `emitBinaryAluOp(op, wt, isUnsigned)`:
  the sole op-and-signedness → ALU opcode site.
- Add `baseOpOfCompound(op)` (exported from the AST module — sema and
  codegen live in separate closures) as the one _ASSIGN-stripping site;
  use it in `emitAssignment`'s compound path and in
  `typesAreOperandCompatible`.
- SHR keeps the explicit `OP_SHR_U`/`OP_SHR_S` selection inside the helper:
  `ALU` has no flag-form `OP_SHR` (only the two distinct constants;
  `getaop`/`WAop` have no OP_SHR+sign path), so a flag form would be new
  mechanism, not reuse.

## Acceptance

- Pure refactor: SameBoy (`vendor/sameboy/bin.json` via
  `os-common.buildProject`) compiled with the pre- and post-change compiler
  is byte-for-byte identical (proves the two tables agreed).
- Full unit (incl. conformance signed/unsigned DIV/MOD/SHR/compare
  coverage) + ast + host + blockfs + kernel suites green.
- No emitted-byte change → no image bake, no image.json bump; no os/ C,
  host.js, or kernel.js touched.
