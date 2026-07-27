# 0326 — SDecl._withChildren silently drops a rewrite of a declaration initializer

- **Status**: open
- **Priority**: P2 (latent silent wrong-code; no live consumer today, and that is
  the whole hazard — it is a trap armed for the next pass that adds a rewriting walker)
- **Difficulty**: medium
- **Design**: —
- **Provenance**: reported by the `todos/0319` lane while fixing the read side of
  this same asymmetry. It judged the gap pre-existing, wider than a P0 warranted,
  and filed nothing — so it lived only in a chat message. Filed here by @master
  (cont-95) under the standing rule that *a gap that does not enter `todos/` does
  not exist*. **Not opened by 0319's change**, but 0319 made it sharper: see below.

## The gap

`compiler.js`'s `SDecl` overrides the generic child-rewrite hook with a no-op:

```js
_withChildren(_) { return this; }
```

Every other `Stmt`/`Expr` subclass returns a **new node built from the children it
was handed**. `SDecl` returns itself and throws the new children away. So a
generic children-based rewriter — the shape used by every `map`-style tree pass —
walks into a declaration, produces a rewritten initializer subtree, hands it back,
and **the rewrite is silently discarded**. No error, no warning; the pass reports
success and the tree is unchanged.

### Why 0319 made this sharper rather than safer

0319 fixed the **read** side: `SDecl.children` is now a live accessor that
recomputes from `this.declarations`, so a walker always *sees* the current
initializers. The **write** side is still the no-op above. The result is an
asymmetry that reads as correct:

- a walker's read is now guaranteed fresh ⇒ the pass looks trustworthy;
- its write is guaranteed lost ⇒ the pass is a no-op on declarations.

Before 0319 both sides were stale together, which at least failed consistently.
The two passes that rewrite declaration initializers today — constant folding
(`foldStmt`) and `rewriteLongjmpInStmt` — both dodge the hook entirely by mutating
`d.initExpr` **in place**, which is precisely the workaround that made this
invisible for so long and precisely the mutation that caused 0319.

## Plan

1. Decide the contract, and say which one in a comment:
   - **(a) make it work** — `_withChildren(newChildren)` rebuilds the `DVar`s
     (or a new `SDecl`) so a rewritten initializer actually lands. Note `SDecl` is
     `Object.freeze`d and `DVar`s are `Object.seal`ed, so this means constructing
     new declarations, and every holder of a `DVar` identity (symbol table
     entries, `compoundLiteralOffsets`-style identity Maps) must be checked for
     staleness — this is the real cost and the reason it is not a one-liner.
   - **(b) make it loud** — if in-place mutation is the deliberate contract, then
     `_withChildren` must **throw** when handed children that are not identical
     (`===`, elementwise) to the current ones, so a would-be rewriter fails at the
     point of the drop instead of silently no-op'ing. Cheap, and it converts a
     silent wrong-code path into a compiler bug report, exactly like 0319's
     `emitFrameAddr` hardening.
   - (b) is the recommended default; (a) only if a real rewriting pass needs it.
2. Audit in-place initializer mutation: `foldStmt` (`compiler.js:~6096`) and
   `rewriteLongjmpInStmt` (`~14430`). Under (b) they stay as they are and get a
   comment saying *why* they bypass the hook; under (a) they move onto it.
3. Sweep the other `Stmt` subclasses for the same no-op/identity `_withChildren`
   shape — this ticket is about the class of defect, not one line. Give a per-site
   reason a clean one is clean (the 0319 audit format).

## Acceptance

- A test that constructs a generic children-based rewrite over a function
  containing `int x = f(1);`, rewrites the initializer, and asserts the outcome
  the chosen contract promises: under (b) it **throws** a compiler-internal error
  naming the drop; under (a) the emitted code reflects the rewrite.
- The audit of step 3 is written down in the ticket or the dev log, one line per
  site, including the sites judged clean.
- `unit`, `kernel`, `todos` and the browser sweep stay green at their current
  baselines; no `os/image.json` bump is owed unless the chosen fix changes codegen.
