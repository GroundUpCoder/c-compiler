# WAST Stage 1 — flat substrate, byte-identical (todos/0197)

The compiler's function bodies now build a target-side instruction
representation — `WAST`, a new top-level IIFE between Parser and Codegen —
and serialize it into the same byte arrays afterwards. Output is
byte-for-byte identical to the streaming path it replaces; this entry
records the design points and the two things that actually bit.

## Why

Target-level transforms (inlining, peephole — the 0188 conclusion was that
headline perf is rule-bound, not visibility-bound, so the next win is
post-codegen) are miserable against a byte stream: branch depths are baked
relative numbers, so splicing instructions in or out invalidates every
`br` that crosses the splice. Stage 1 buys the representation those passes
need without changing a single output byte, so the entire estate + a
system-image bake can prove the refactor NO-OP before any transform lands.

## Shape (decided up front, three engine reviews concurring)

- **Flat sequence, not operand tree.** One node per wasm instruction in a
  per-function array; operands stay implicit on the value stack; control
  is delimiter nodes (`WBlock`/`WLoop`/`WIf`/`WTryTable` … `WEnd`). No
  Binaryen-style nesting — depth is derived at serialize time.
- **Symbolic labels.** `WBr`/`WBrIf`/`WBrTable` and try_table catch
  entries hold a label IDENTITY — the structural node they target, or the
  per-function FUNC label sentinel. `WastBuilder.br(depth)` resolves the
  numeric depth against its live control stack at the ONLY moment it is
  valid (build time); `serialize()` re-derives relative depths from its
  own walk stack. Nothing authoritative is ever a baked depth again.
- **Thin family nodes.** `WAop{wt,op,sign}` rides the existing `getaop`
  table (147 call sites), `WMop{opcode,offset,align}` covers all 19
  load/store forms, `WGCOp{subop,imms}` the uniform 0xFB tail,
  `WRefOp{kind,imm}` the ref ops (their encodings mix raw-byte/signed-LEB
  forms, so they can't share WGCOp's shape). Dispatch by
  `switch(node.constructor)`, the AST idiom.

`WastBuilder` implements WasmCode's exact method surface, so the ~545
`this.body.*` call sites in Codegen changed zero characters. The
target-side tables and encoders (`WT_*`, `wtEmit`, `getaop`, `MOP`, `ALU`,
`appendF32/64`, and the demoted `WasmCode` itself) were RELOCATED from
Codegen into WAST verbatim; Codegen destructures them back. `WasmCode`
survives for the 2-instruction constant expressions (global inits,
data-segment offsets) where a node layer has zero value.

Long-tail details that are now first-class instead of raw bytes:

- **3-way block type.** `{tag:"typeidx", idx}` joined `wtEmit`'s union;
  the multi-param catch clause (`block` with a function-type index, the
  one raw `push(0x02)+lebI` in the tree) now goes through `block()`.
- **`EWasm` raw bytes** coalesce into `WRaw`, serialized verbatim. Real
  `__wasm()` carriers are flat single instructions, so it's structurally
  safe; it becomes an optimization BARRIER in later stages.
- **Source locs** became zero-width `WSrcLoc` markers (there are no byte
  offsets while building nodes); `serialize()` reports each marker's
  body-relative offset through an `onSrcLoc` callback into the same
  `currentFuncSourceMap` shape. Rebasing and the `c.sourcemap` section
  didn't change; the dedup (consecutive same file:line) moved into the
  builder and is order-identical.

## What bit

1. **The goto-rollback attempt is allowed to be unbalanced.** hush's
   `parse_stream` (and every irreducible function) first gets a structured
   emit attempt; when that hits out-of-scope gotos the driver rolls the
   bytes back and re-emits through the loop-switch lowering. The old
   stream didn't care that the doomed attempt left forward-label blocks
   open — the new `validate()` did. Fix: when `gotoErrors` grew during
   the attempt, skip validate/serialize entirely (the bytes are discarded
   on BOTH driver paths — rollback+lower, or report+exit). Found by the
   image bake, not the unit corpus: only big vendor code trips lowering.
2. **`__DATE__`/`__TIME__` vs the identity harness.** quake and tcc expand
   them (frozen at translation start via `new Date()`), so the before/
   after harness runs freeze `Date` globally. Worth remembering for any
   future "hash the estate" gate; the baked image is NOT run-to-run
   reproducible without it.

## The gate (all foreground, this machine)

- Byte-identity harness (compile all tests/unit in-process + build all 25
  vendor bin.jsons + bake the system image in-memory and hash every file):
  **654 wasm hashes + 162 image entries, zero diffs** against the
  pre-change baseline (which was itself run twice to prove determinism).
- disw + sourcemap goldens: pass, not regenerated (8/8).
- unit 715 + 8 xfail; run.py categories 266 + disw/sourcemap 8; blockfs
  15; host ok; kernel 73 (446s, includes full OS boots); browser sweep
  25/25. micropython-upstream 513 passed / 3 failed — the same 3 float
  tests fail on clean HEAD (pre-existing, environmental).
- `tools/mkimage.js`: v93 bakes, seals, verifies.

## Deliberately NOT here

No inliner, no peephole, no nested/tree view, no WasmCode deletion, no
emitStmt/emitExpr change. `validate()` checks structure (balance, else
placement, label liveness, blocktype shape), not stack typing — the
engine-level `WebAssembly.validate` backstop already covers that class.
Next stages get: after-every-transform validation for free, and splice
safety from label identity.
