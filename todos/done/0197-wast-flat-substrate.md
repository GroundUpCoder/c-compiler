# 0197 — WAST flat substrate (Stage 1, byte-identical)

- **Status**: done (2026-07-15; WAST substrate landed — flat node sequence + symbolic labels + WastBuilder mirroring WasmCode's surface, function bodies serialize through it BYTE-IDENTICAL: 654 unit/vendor wasm hashes + 162 baked-image entries match the pre-change baseline, disw/sourcemap goldens untouched, full estate green, mkimage v93 seals. No optimization passes — those are later stages. Log: logs/2026-07-15/wast-flat-substrate-0197.md)
- **Design**: logs/2026-07-15/wast-flat-substrate-0197.md

## Goal

Add WAST, a target-side wasm instruction layer below the C AST (a new
top-level IIFE, sibling of `AST`), and route function-body emission through
it — with BYTE-IDENTICAL output across the entire test estate and a full
system-image bake. This is the substrate for later target-level transforms
(inlining, peephole); Stage 1 lands NO optimization passes.

Architecture (decided; don't relitigate):

- **Flat, not tree**: a per-function array of instruction nodes; operands
  stay implicit on the wasm value stack; control constructs are delimiter
  nodes (`WBlock`/`WLoop`/`WIf`/`WTryTable` … `WEnd`), no nested bodies.
- **Symbolic labels**: branch nodes hold a label IDENTITY (the structural
  node they target, or the per-function FUNC label). The builder resolves
  `br(depth)` against its live control stack at build time; the serializer
  re-derives relative depths on its walk. No baked depths anywhere —
  that's what makes later splice-based inlining safe.
- **Thin family nodes** (~30 classes): `WAop`/`WMop`/`WGCOp`/`WRefOp` lean
  on the existing `getaop`/`MOP`/subop tables; immediates only, dispatch by
  `node.constructor`, no C typing, no freezing.

## Plan

1. `const WAST = (() => …)()` before Codegen: relocate the target-side
   type/opcode tables + byte encoders (`wtEmit`, `getaop`, `MOP`, `ALU`,
   `WT_*`, `appendF32/64`, the demoted `WasmCode`) and add node classes,
   `WastBuilder` (WasmCode's exact method surface, appending nodes),
   `serialize(fnNodes, out, {onSrcLoc})`, `validate(fnNodes, funcLabel)`.
2. `emitFunctionBody` builds nodes (zero emitStmt/emitExpr changes),
   validates, then serializes into `wmod.funcDefs[defIdx].body` — the
   driver's goto-rollback truncation keeps working; a structured attempt
   that hit out-of-scope gotos skips validate/serialize (its bytes are
   discarded either way, and its control may be legitimately unbalanced).
3. 3-way block type made first-class: `{tag:"typeidx", idx}` in `wtEmit`
   retires the raw `push(0x02)+lebI` at the multi-param catch site.
4. `EWasm` raw bytes coalesce into `WRaw` (verbatim, stack-opaque — an
   optimization barrier later).
5. Source locs become zero-width `WSrcLoc` markers; the serializer reports
   byte offsets via `onSrcLoc`; rebasing/custom-section unchanged.
6. `WasmCode` demoted (global-init / data-offset constant exprs only).

## Acceptance

- Byte-identity harness (frozen `Date` for `__DATE__`/`__TIME__`): SHA-256
  of every compiled unit/conformance test, every vendor `bin.json` build,
  and every file in an in-process system-image bake — identical before and
  after. ✔ (654 wasm hashes + 162 image entries, zero diffs)
- disw + sourcemap byte-level goldens pass UNTOUCHED. ✔
- Full estate green: unit / run.py categories / blockfs / host / kernel /
  browser sweep. ✔ (micropython-upstream's 3 float failures reproduce on
  clean HEAD — pre-existing)
- `tools/mkimage.js` bakes + seals v93. ✔
