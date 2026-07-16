# 0214 — WAST Stage 3c: tree-shake, single-use inline-and-delete, inline hints

- **Status**: done (2026-07-16 — treeShakeFunctions + tableLayout remap
  (slots immutable, survivors at original slots, addr-taken roots via
  `_funcAddrEscape` at the three escape sites), single-use budget bypass
  with live site counts, attributes threaded parser→fnAttrs→fnMeta→WAST
  policy (noinline hard / always_inline bypass / inline→hintCalleeCap
  256, minimal [[gnu::…]] in the decl-specifier position), __wasm op
  groups refuse call/return_call/ref.func heads so WRaw stays
  reference-free. SameBoy: sums IDENTICAL vs baselines + clang;
  296707→237095 B (−20.1%), 127064→97486 instrs, ms/frame flat
  6.367→6.346 — −12.6% below even the pre-0201 baseline. Differential
  knob `tests/run-unit.js --wast-inline=off|on|max`, corpus green under
  all three. Estate green: unit 723+8xfail, ast, run.py cats, blockfs,
  host, kernel 73/73 (fresh v100 bake), sweep 27/27; disw + sourcemap
  goldens updated for the new module shape (line_numbers dogfoods
  noinline). os-wm under-load flake found during the sweep is
  PRE-EXISTING (identical on pristine main) → filed P0 todos/0215.
  Log: logs/2026-07-16/wast-tree-shake-0214.md)
- **Design**: WAST substrate + inliner (todos/done/0197/0198/0200/0201/0209),
  pass seam `WAST.runPasses`; tests/ast/test_wast_inline.js (0201 style)

## Goal

Make the 0201 inliner NET-POSITIVE on code size. Today it ships ~+9.5%
wasm bytes because inlined-away callees stay in the module ("never delete
inlined-away functions — indices baked into call immediates + element
section"). Recover that, without changing observable behavior:

1. **Tree-shake**: after inlining, delete functions unreachable from the
   roots (function exports + address-taken functions) over the WCall
   graph. This also collects functions that were ALREADY dead at the WAST
   level (extern-linkage but never referenced — the per-TU AST shake
   can't see across TUs and keeps them).
2. **Single-use inline-and-delete**: a callee whose ONLY reference in the
   whole module is one WCall site (not exported, not address-taken)
   inlines regardless of the size budgets — the body MOVES rather than
   duplicates, and the shake then deletes the original. Net size ≤ 0 by
   construction.
3. **Inline hints, end-to-end**: `__attribute__((noinline))` /
   `[[gnu::noinline]]` → hard refusal (even single-use; also refused by
   the AST-level INLINER.tryInline); `__attribute__((always_inline))` /
   `[[gnu::always_inline]]` → bypass calleeCap/callerGrowth (soundness
   refusals — variadic/alloca/sret/over-aligned/eh/raw/imported/self,
   and the localCap engine limit — still apply); plain `inline` → raised
   effective calleeCap (`hintCalleeCap`). Attribute flags were parsed
   and DROPPED before this item (only `aligned` was consumed); now they
   thread parser → `DFunc.fnAttrs` → codegen `fnMeta` → WAST policy.

## The crux — safe function-index remapping

Deleting a defined function renumbers every defined function after it.
The design constraint discovered up front: **C function pointers are the
function's TABLE slot (`funcIdx + 1`), baked as plain i32 constants into
code AND data segments** (vtables, callback tables) — those constants
are unfindable post-hoc, so table SLOTS are immutable. The remap
therefore:

- keeps the table at its pre-shake size and keeps every surviving
  function at its ORIGINAL slot (`oldIdx + 1`); the element section
  changes from one identity run to runs that skip deleted slots
  (`wmod.tableLayout`, consumed by emit()'s table/element writers;
  absent → the pre-0214 identity path, byte-identical);
- deleted functions leave null slots — provably unreachable, since any
  function whose table index ever escaped as a value is address-taken
  and address-taken functions are ROOTS (recorded at the three codegen
  escape sites: emitAddressOf, EIdent-as-value, the constEval address
  policy that bakes static initializers — over-approximation is safe);
- rewrites, in one pass over the survivors: every `WCall.funcIdx`, the
  export section's function entries, and the name section (funcNames +
  localNames; entries of deleted functions dropped). `WCallIndirect`
  carries type/table indices only; WRefOp/WGCOp imms are type indices;
  no start section exists. Sourcemap entries are recorded at serialize
  time (post-shake) so they never see old indices.
- **Refusal over cleverness**: the shake ABORTS (stats.aborted, loud in
  passStats) if any funcDef has a raw byte body (`wast === null` — call
  immediates baked in bytes are unenumerable and unrewritable) or if
  any surviving body contains WRaw. A remap that would leave a WCall
  pointing at a deleted function throws (loud-fail) — reachability makes
  it impossible, the check is the belt-and-braces.

Pass order: inline (with single-use/always_inline bypasses) → tree-shake
(+remap) → foldMemOffsets → re-validate every rewritten function. One
inline→shake round (no fixpoint): reachability from roots already deletes
transitive chains; a callee that only becomes single-use because its
OTHER caller died is a recorded missed win, not a correctness issue.

## Plan

- Parser: collect attribute FLAGS (today discarded) at the two function
  sites (decl-specifier position, post-declarator) into
  `specs.fnAttrFlags`; minimal `[[...]]` support at those same positions
  (`gnu::noinline`/`gnu::always_inline`, unknown attributes skipped);
  stamp `DFunc.fnAttrs = {noinline, alwaysInline}`; merge prototype →
  definition at the prev-decl sites (per-TU, like gcc).
- Codegen: `fnMeta` grows `noinline/alwaysInline/inlineHint(isInline)`;
  `wmod.addrTakenFuncs` populated at the three table-index escape sites.
- WAST: `inlineFunctions` gains noinline refusal, alwaysInline bypass,
  `hintCalleeCap` (inline-keyword callees), single-use bypass with live
  site-count maintenance (splices add the clone's calls, consumed sites
  decrement); new `treeShakeFunctions(wmod)` + `shakeDefaults`;
  emit() honours `wmod.tableLayout`.
- tests/ast/test_wast_inline.js: pinned cases — noinline refusal,
  always_inline over-budget inline, single-use over-budget inline+delete,
  tree-shaken dead function, remap correctness (WCall immediates,
  exports, funcNames, tableLayout slots), abort-on-raw, and end-to-end C
  execution incl. a function-pointer-through-deleted-neighbour check.
- tests/run-unit.js: `--wast-inline=off|on|max` knob (mutates
  WAST.inlineDefaults/shakeDefaults in-process) so the OFF/ON/MAX
  full-corpus differential is a committed one-liner.

## Acceptance

- New ast tests green; full unit corpus green under off/on/max (zero
  output divergence).
- SameBoy bench: checksums IDENTICAL vs baselines.json + clang leg;
  code size neutral-or-better vs the pre-0201 baseline (the +9.5% is
  recovered); ms/frame flat (informational).
- Full estate green at the end (mkimage bake + kernel suite + browser
  sweep) — integration once, not per-commit.
