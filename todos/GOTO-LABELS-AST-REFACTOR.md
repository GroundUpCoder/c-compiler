# Goto/Label AST refactor

Replace the pointer-and-cached-state design for `SGoto`/`SLabel` with a
purely structural design that uses string names and derived classification.
Parallels the recently-done `SCase` refactor (which replaced
`SSwitch.cases` with the in-tree `SCase` node + `caseBag` TreeBag).

## Background — the bug class we're avoiding

`SSwitch` used to carry a side-channel `cases: [{value, isDefault, stmtIndex,
localCompound, localIndex}]` array of case entries, with `localCompound`
back-pointing into the body's SCompound objects. Multiple AST rebuild sites
(`foldStmt`, `rebuildAlongPath`, `lowerLongjmpInStmt`, etc.) passed
`stmt.cases` through unchanged while rebuilding `stmt.body` into a fresh
SCompound — so `case.localCompound` aliased the *old, detached* compound
and the structured codegen's nested-case detection silently broke.

That refactor moved cases to first-class AST nodes (`SCase`) embedded
inside the body's statement list and exposed them via a `caseBag` TreeBag.
Result: cases move with the body through any rebuild, no maintenance
required, and the structural shape can't drift from the cached metadata
because there's no cached metadata.

The same hazard exists today for gotos and labels. This document plans
fixing it the same way.

## Current design

Per-function during parse (`compiler.js:8028-8029`):

```
parsedLabels: Map<name, SLabel>     // labels seen so far in this function
pendingGotos: Map<name, SGoto[]>    // unresolved forward gotos
```

`SGoto` carries `target: SLabel | null` (`compiler.js:3601`). `SLabel`
carries `name`, `enclosingBlock`, `labelKind` (FORWARD/LOOP/BOTH),
`hasGotos`, `isSwitchLevel` (`compiler.js:3604`). Both are
`Object.seal`, not `Object.freeze`, because the parser writes back into
them after construction.

Parser builds the link:

- `goto X;` (`compiler.js:10158-10186`):
  - Create `SGoto(label=X, target=null)`.
  - If X is in `parsedLabels` → backward goto. Set `sg.target = parsedLabels.get(X)`. Promote target's `labelKind`: FORWARD→BOTH (if it already `hasGotos`), default→LOOP. Set `target.hasGotos = true`.
  - Else → forward goto. Push onto `pendingGotos[X]`; target stays null.

- `X:` (`compiler.js:10189-10212`):
  - Create `SLabel(name=X)`.
  - Record in `parsedLabels[X]`.
  - If `pendingGotos[X]` is non-empty, walk it and set each pending `sg.target = sl`. Mark the label `hasGotos = true`, `labelKind = FORWARD`. Clear the pending list.

- Function end (`compiler.js:10650-10653`):
  - Anything still in `pendingGotos` → "Undefined label" diagnostic.
  - Both maps cleared (labels are function-scoped).

Transforms maintain the link by **identity preservation, not active
relinking**. SGoto and SLabel fall through every pass's terminal
`return stmt` (`foldStmt:4854-4859`, `hoistDeclarations:5993`, etc.).
`rebuildAlongPath` only rewrites container nodes. So when a parent
SCompound is rebuilt with new statements, the SLabel inside is the same
JS object, and `goto.target === label` still holds.

Two places explicitly manipulate the link:

1. **GOTO_NORMALIZER** (`compiler.js:5446-5475`): creates new SGoto/SLabel
   pairs for synthesized skip-labels and sets `.target` directly. Reads
   `g.target === label` (`5740, 5769`) to find gotos targeting a label.
2. **IRREDUCIBLE_LOWERING**: deletes SGoto/SLabel entirely (body becomes
   a state-machine `while-switch` with gotos turning into `state = N;
   continue`). Doesn't use the link.

## Why this is fragile

The current model works because *every transform either preserves SLabel
identity or fixes up the pointer explicitly*. That invariant is unwritten
and easy to violate. Any future transform that wants to:

- Rename an `SLabel.name` (for hygiene during inlining)
- Replace an `SLabel` with a fresh instance (e.g., during normalization)
- Duplicate an `SLabel` (during inlining a labeled body)

…must walk the function and update every `SGoto.target` pointing at the
old label. The invariant is unenforced.

The cached classification (`labelKind`, `hasGotos`) has its own version
of this — if a transform adds/removes gotos in a subtree, the cached
classification on the label is stale unless explicitly updated.

`SCompound.labels` (`compiler.js:3496-3499`) is the *same* bug class as
the old `SSwitch.cases`: cached array of refs into the subtree, kept in
sync by convention only. Its one reader (`alwaysReturns` at `10827`)
would silently give the wrong answer if anything drifted.

`SLabel.enclosingBlock` is dead — written in the constructor and once by
goto-hoisting (`5467`), read nowhere. Pure overhead.

## Proposed design

### 1. String names for the goto/label link

- `SGoto` becomes `{ loc, label: string }` — no `target`.
- `SLabel` becomes `{ loc, name: string }` — no `enclosingBlock`,
  `labelKind`, `hasGotos`, `isSwitchLevel`.
- Both become `Object.freeze`.

Resolution moves to use time. The parser still maintains
`parsedLabels`/`pendingGotos` for parse-time "undefined label"
diagnostics — those are transient parser state, not AST data, and don't
need to leak into nodes.

### 2. `gotoBag` TreeBag on `Stmt`

Mirrors `caseBag`:

```js
// Stmt base
get gotoBag() {
  return new TreeBag(null,
    ...this.children.filter(c => c).map(c => c.gotoBag));
}
// SGoto
get gotoBag() { return new TreeBag([this]); }
// SLabel
get gotoBag() { return new TreeBag([this]); }
```

Iteration order is source order, because every Stmt subclass already
passes children in source order to `super()`. So
`funcBody.gotoBag` yields SGoto/SLabel nodes interleaved in textual
order across the entire function body — exactly the order C label
classification semantics need.

### 3. `labelBag` (replaces `SCompound.labels`)

Subset of `gotoBag` that yields only `SLabel`. Default Stmt:
`new TreeBag(null, ...children.map(c => c.labelBag))`. SLabel:
`new TreeBag([this])`. The one current reader is `alwaysReturns`
(`compiler.js:10827`), which becomes `stmt.labelBag.size > 0`.

(We could just check `gotoBag` and filter, but a separate `labelBag`
makes the intent at the call site explicit and lets readers that only
care about labels skip materializing gotos. Cheap either way.)

### 4. Derived classification

Codegen (and any pass that needs label kinds) calls a helper:

```js
function classifyLabels(funcBody) {
  const seen = new Set();         // label names passed so far
  const fwd = new Map();          // name → gotos textually before label
  const back = new Map();         // name → gotos textually after label
  const byName = new Map();
  for (const node of funcBody.gotoBag) {
    if (node instanceof SLabel) {
      if (byName.has(node.name)) throw new Error(`duplicate label '${node.name}'`);
      seen.add(node.name);
      byName.set(node.name, node);
    } else { // SGoto
      const m = seen.has(node.label) ? back : fwd;
      m.set(node.label, (m.get(node.label) || 0) + 1);
    }
  }
  const out = new Map();          // SLabel → { labelKind, hasGotos }
  for (const [name, label] of byName) {
    const f = fwd.get(name) || 0, b = back.get(name) || 0;
    out.set(label, {
      hasGotos: f + b > 0,
      labelKind: (f && b) ? "BOTH" : b ? "LOOP" : "FORWARD",
    });
  }
  return out;
}
```

One O(N) walk per function at codegen, replacing per-label cached state.
Bounded — switches/labels are rare per-function.

### 5. `SLabel.isSwitchLevel` becomes local codegen state

This is a transient flag set during structured-codegen's SSwitch case
(`compiler.js:13257-13263`) to coordinate forward-label block opening
with the enclosing switch. It doesn't belong on the AST. Replace with a
local `Map<SLabel, boolean>` (or just a `Set<SLabel>`) inside the
codegen state.

## Migration order

Each step is small and independently testable.

1. **Delete `SLabel.enclosingBlock`.** Zero-risk: only written, never
   read. Drop the constructor param, fix the three call sites (parser
   `9632`, hoist-skip-label `5471`, anywhere else `git grep` finds).

2. **Add `gotoBag` + `labelBag` getters; add `classifyLabels`.** Both
   getters on `Stmt` base, `SGoto`/`SLabel` overrides. Migrate readers
   off `sl.labelKind` / `sl.hasGotos` to consult `classifyLabels`
   results. Test that classification matches the old cached values for
   every function in the test suite (one-time assertion during
   migration; remove once green).

3. **Switch `SGoto.target` (pointer) → `SGoto.label` (already a
   string).** Update GOTO_NORMALIZER's identity checks (`5740, 5769`)
   from `g.target === label` to `g.label === label.name`. Drop the
   `target = sl` writes in the parser. Freeze SGoto/SLabel.

4. **Replace `SCompound.labels` with `labelBag`.** Migrate the one
   reader (`alwaysReturns:10827`). Drop the parser's compound-side
   label tracking (`compiler.js:10199-10202`). Drop the
   `labels` arg from SCompound's constructor and `_withChildren`.
   Drop the rebuild-site propagation (5 sites).

5. **Move `isSwitchLevel` to codegen-local state.** Remove from
   SLabel; add a `switchLevelLabels: Set<SLabel>` to the
   structured-codegen SSwitch case.

After step 5, SLabel has only `{ loc, name }`. SGoto has only `{ loc,
label }`. Both are `Object.freeze`. The only references between them are
string-keyed and resolved at use time.

## What stays

- `SGoto.label` (the string) and `SLabel.name` (the string) — these are
  the source-level names, no aliasing risk.
- The parser's `parsedLabels` / `pendingGotos` — transient parse-time
  state for "undefined label" diagnostics. Doesn't leak into AST.
- The DVar/DFunc/DTag pointer-identity model — declarations are
  identity-bearing entities by design, not fungible structural values.
  This refactor is specifically about *statements*, which should be
  fungible.

## Cost/benefit

**Cost:** one O(N) classification walk per function at codegen
(currently amortized over per-label O(1) reads of cached state). For
realistic functions this is well below the noise floor.

**Benefit:**

- SGoto and SLabel become truly immutable. No mutable post-construction
  state, no pointer-equality invariants for transforms to maintain.
- Any future transform (inlining, hygiene rename, dead-label
  elimination) just rebuilds nodes — names line up automatically,
  classification re-derives.
- The same TreeBag pattern as `caseBag` — uniform mental model.
- `SCompound.labels`'s aliasing-bug class disappears.

## Out of scope

- Replacing pointer-identity on `DVar.definition`/`DFunc.definition` etc.
  Declarations are *meant* to be identity-bearing entities preserving
  cross-reference; that's proper design. This refactor is only about
  the *statement* AST.

- `EInitList.unionMemberIndex` mutable-after-construction state — also
  uncomfortable, but a different problem (no cross-tree pointer). Owed
  refactor noted at `compiler.js:3382-3389`.
