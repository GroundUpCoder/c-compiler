# 0319 — Compound literal in a local declaration initializer clobbers the caller's stack frame

- **Status**: done (2026-07-27)
- **Priority**: P0 (silent wrong-code in a shipped feature)
- **Difficulty**: medium
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe. It is the single
  defect standing between a compiled CPython 3.13.5 and a usable one:
  `python -c "print(1+1)"` works, but `import json` / any generator expression
  dies inside CPython's own bytecode compiler with `free: double free detected`.

## The bug

A **struct-typed compound literal appearing in a local variable declaration's
initializer** is missed by the frame-layout walk, so it gets no frame slot.
`compoundLiteralOffsets.get(cl)` returns `undefined`, and `emitFrameAddr`
silently computes `savedSp + (undefined - frameSize)` → `NaN` → `i32Const` 0 →
the literal is written at **`savedSp`, which is the CALLER's frame**.

Minimal repro (clang and gcc both print `OK`):

```c
#include <stdio.h>

typedef struct { int a, b, c, d; } loc_t;

static void callee(int n)
{
    loc_t l = (loc_t){ n, n, -1, -1 };   /* <-- compound literal in an initializer */
    (void)l;
}

int main(void)
{
    volatile int canary = 0;
    int guard[4] = { 0, 0, 0, 0 };
    callee(0x5A);
    printf("canary=%d guard={%d,%d,%d,%d} %s\n", canary,
           guard[0], guard[1], guard[2], guard[3],
           (canary == 0 && !guard[0] && !guard[1] && !guard[2] && !guard[3])
             ? "OK" : "*** CALLER FRAME CLOBBERED ***");
    return 0;
}
```

```
ours : canary=0 guard={90,90,-1,-1} *** CALLER FRAME CLOBBERED ***
clang: canary=0 guard={0,0,0,0} OK
```

The literal's `{0x5A, 0x5A, -1, -1}` lands exactly on the caller's `guard[4]`.

**Only the declaration-initializer position is affected.** Measured with an
assertion wired into `emitFrameAddr`:

| position of the compound literal          | result |
|-------------------------------------------|--------|
| `loc_t l = (loc_t){...};`                  | **MISSED BY FRAME LAYOUT** (offset `undefined`) |
| `loc_t l; l = (loc_t){...};`               | OK |
| `l = *&(loc_t){...};`                      | OK |
| `static_obj = (loc_t){...};`               | OK |
| `(loc_t){...}.a` as a member-access base   | OK |

`const` on the literal, and designated vs positional initializers, make no
difference. Replacing the literal with a named temporary is clean — which is
why this has stayed hidden: most in-tree C writes the named-temp form.

C11 6.5.2.5p5: a compound literal at block scope has automatic storage duration
associated with the enclosing block, i.e. it is a frame object.

## Root cause

`compiler.js:17899` / `:17928` build the frame layout by walking
`funcDef.body.referencedCompoundLiterals`. That bag does not reach compound
literals inside a **local declaration's initializer** (the literal hangs off the
`DVar`'s init expression, not off a statement in `body`), so no entry is added
to `compoundLiteralOffsets`.

`emitFrameAddr` (`compiler.js:17384`) then runs
`this.body.localGet(this.savedSpLocalIdx); const adj = offset - this.frameSize;`
with `offset === undefined`. `adj` is `NaN`, the `adj !== 0` guard passes, and
the emitted constant degrades to 0 — the caller's frame base. **A missing frame
slot becomes silent memory corruption rather than a crash.**

## Plan

1. Make the frame-layout walk reach compound literals in local-declaration
   initializers (include `DVar` init expressions in the bag, or have layout walk
   the same tree codegen walks).
2. **Harden `emitFrameAddr`**: throw on a non-finite offset. This is the part
   that turns the next instance of this class into a loud compile-time failure
   instead of stack corruption. A one-line
   `if (!Number.isFinite(offset)) throw new Error(...)` reproduced the diagnosis
   in seconds after hours of runtime bisection.
3. Audit the other `compoundLiteralOffsets.get(...)` consumers
   (`compiler.js:17763`, `:19200`, `:19308`, `:20292`) for the same
   `undefined`-degrades-silently shape.

## Acceptance

- The repro above lands as a conformance test under `tests/unit/conformance/`
  (clang-verified `expected.stdout`) and passes.
- `emitFrameAddr` fails loud on a missing offset: a deliberately-broken layout
  produces a compiler error, not a bad address.
- A regression guard for each of the five positions in the table above.

## Resolution

The root cause is one notch upstream of "the bag doesn't reach DVar
initializers" — it *did* reach them, through a **stale snapshot**. `SDecl`
built its `children` array once at construction from the DVars' `initExpr`
fields, but DVars are sealed-not-frozen and later passes rewrite `d.initExpr`
**in place** rather than rebuilding the SDecl (constant folding at the
`case AST.SDecl` arm of `foldStmt`, the longjmp lowering's `rewriteLongjmpInStmt`).
The moment such a rewrite produced a new node, `children` pointed at the
pre-rewrite subtree: the frame-layout walk allocated a slot for the OLD
`ECompoundLiteral` while codegen emitted the NEW one, and the identity-keyed
`compoundLiteralOffsets.get()` missed.

That is why the literal in the repro had to contain a foldable subexpression:
`(loc_t){ n, n, -1, -1 }` clobbers, `(loc_t){ n, n, n, n }` does not — the
latter's node identity survives folding. It is also why only the
declaration-initializer position was affected: every other position hangs off
an `SExpr`/`SReturn`/… whose `_withChildren` rebuild keeps node identity and
child list in lockstep.

Fix, all three plan steps:

1. `Stmt.children` is now a prototype **accessor** over `_children`, and
   `SDecl` overrides it to recompute the list live from `this.declarations`.
   Every consumer of `children` — the three bubble-up bags, the generic tree
   walkers, the tree-shaker's reference visit — now sees the initializer
   codegen will actually emit. SDecl was the only node whose child list
   mirrored state living outside the node; the rest either share the array
   reference (SCompound/statements) or rebuild.
2. `emitFrameAddr` throws on a non-finite offset. All four
   `compoundLiteralOffsets.get()` consumers converge on it (directly, or via
   `emitInitToFrameSlot`/`emitStringToFrameSlot`, or via `lvaluePush`'s
   `LV_ADDR_FRAME` arm), so the single check covers the whole class — verified
   by deliberately dropping the layout entry: the compiler errors with
   `internal: frame address with non-finite offset (undefined)` instead of
   emitting a caller-frame address.
3. Audit: none of the four sites (`emitCompoundLiteralInit`, `emitLValue`,
   `emitAddressOf`, `emitExpr`) guarded the lookup — all had the same
   silent-degrade shape, and all are now loud. The sibling maps
   (`localArrayOffsets`, `paramMemoryOffsets`) already use explicit
   `!== undefined` fallthrough chains ending in a `throw`; the hardening gives
   the compound-literal sites the same backstop.

Tests: `tests/unit/conformance/compound_literal_frame_clobber` (`knownBug` pin
removed — a hard pass now) and the new
`tests/unit/conformance/compound_literal_frame_positions`, one clang-verified
guard per row of the table above.
