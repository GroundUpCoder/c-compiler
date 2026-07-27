# 0319 — the compound literal that wrote into its caller's frame

`todos/0319` (P0, silent wrong-code in the shipped compiler). Found by the
`todos/0313` CPython M0 probe: `python -c "print(1+1)"` worked, but `import json`
or any generator expression died in CPython's *own* bytecode compiler with
`free: double free detected`.

## What actually broke

The ticket pinned the symptom precisely — a struct-typed compound literal in a
local declaration's initializer got no frame slot, `compoundLiteralOffsets.get()`
returned `undefined`, and `emitFrameAddr`'s `savedSp + (undefined - frameSize)`
went `NaN` → `i32Const 0` → the literal landed on the **caller's** frame base.

The diagnosis one notch up was subtler than "the bag doesn't walk DVar
initializers". It does walk them — `SDecl`'s constructor collects each DVar's
`initExpr` into `children`. The problem is that it collects them **once**:

```js
const initExprs = [];
for (const d of declarations) if (d instanceof DVar && d.initExpr) initExprs.push(d.initExpr);
super(loc, initExprs);
```

DVars are `Object.seal`ed, not frozen, and two passes rewrite `d.initExpr`
**in place** rather than rebuilding the SDecl — constant folding (`foldStmt`'s
`case AST.SDecl`) and the longjmp lowering (`rewriteLongjmpInStmt`). Both leave
`children` pointing at the pre-rewrite subtree. The frame-layout walk then
allocated a slot for the OLD `ECompoundLiteral` object while codegen emitted the
NEW one, and the identity-keyed Map lookup missed.

The falsifiable consequence, which is what confirmed it:

```c
loc_t l = (loc_t){ n, n, -1, -1 };   /* clobbers  — `-1` folds, node rebuilt */
loc_t l = (loc_t){ n, n,  n,  n };   /* fine      — nothing folds, identity survives */
```

That also explains the ticket's five-position table. Every other position hangs
off an `SExpr`/`SReturn`/… whose `_withChildren` rebuild keeps the node and its
child list in lockstep. Only `SDecl` mirrors state that lives *outside* the
node, so only `SDecl` can go stale.

## The fix

`Stmt.children` is now a prototype accessor over `_children`, and `SDecl`
overrides it with a live recompute from `this.declarations`. The base class
comment already promised this property — "the getter form … tolerates the
seal-only escapees whose `children` arrays are mutated by post-construction
passes" — SDecl was the one node that quietly broke it, because its mutation
happens through a *different object*, not through the array.

Making it live fixes the whole class, not just compound literals:
`referencedFunctions` and `referencedVariables` (tree-shaking roots!) and every
generic `node.children` walker were reading the same stale subtree.

## The hardening is the durable half

`emitFrameAddr` now throws on a non-finite offset. This is worth more than the
fix: a missing frame slot was previously *silent stack corruption* — the
`adj !== 0` guard happily accepts `NaN` and the encoder degrades the constant to
0, which is precisely the caller's frame base. The one-line check turned hours
of runtime bisection into a one-shot compile error, and it is what will catch
the next instance.

All four `compoundLiteralOffsets.get()` consumers funnel into it — two directly
(`emitAddressOf`, the `emitExpr` rvalue arm), one via
`emitInitToFrameSlot`/`emitStringToFrameSlot` (`emitCompoundLiteralInit`), one
via `lvaluePush`'s `LV_ADDR_FRAME` arm (`emitLValue`). None of the four guarded
the lookup itself, so one check covers the class. The sibling maps
(`localArrayOffsets`, `paramMemoryOffsets`) were already safe by a different
route: explicit `!== undefined` fallthrough chains ending in a `throw`.

Proved by deliberately dropping the layout entry
(`if (!globalThis.__BREAK_0319) this.compoundLiteralOffsets.set(cl, offset)`):
the compiler errors with
`internal: frame address with non-finite offset (undefined) — a frame object was
missed by the frame-layout walk` instead of emitting a bad address.

## Tests

- `tests/unit/conformance/compound_literal_frame_clobber` — the `knownBug`
  `0319` pin is deleted; it is a hard pass now.
- `tests/unit/conformance/compound_literal_frame_positions` — one guard per row
  of the ticket's table (decl-init / assign / `*&` / static dest / member base),
  each asserting both that the caller's `guard[4]` stays zero and that the
  literal's own values read back. Verified red on `origin/main`'s compiler with
  exactly the ticket's signature: `decl_init guard=90,90,-1,-1`, the other four
  rows clean.
