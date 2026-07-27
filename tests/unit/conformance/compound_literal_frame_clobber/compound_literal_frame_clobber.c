// BUG: a struct-typed COMPOUND LITERAL in a local variable declaration's
//      INITIALIZER is missed by the frame-layout walk, so it gets no frame
//      slot. compoundLiteralOffsets.get() returns undefined, emitFrameAddr
//      computes savedSp + (undefined - frameSize) -> NaN -> 0, and the literal
//      is written into the CALLER's frame.
// C11: 6.5.2.5p5 — a compound literal at block scope has automatic storage
//      duration associated with the enclosing block, i.e. it IS a frame object.
// EXPECT: callee() cannot touch main()'s locals; guard stays all-zero.
//      Only the declaration-initializer position is affected — the same
//      literal in an assignment, behind &, or as a member-access base is fine.
// FIXED: todos/0319. Found by the todos/0313 CPython probe: it is what made
//      CPython's own bytecode compiler double-free on any generator
//      expression. Root cause: SDecl's child list was a construction-time
//      snapshot of the DVar initializers, so a later in-place initializer
//      rewrite (constant folding `-1`) left the frame-layout walk looking at
//      a stale ECompoundLiteral while codegen emitted the new one.
//      See compound_literal_frame_positions for the per-position guards.
#include <stdio.h>

typedef struct { int a, b, c, d; } loc_t;

static void callee(int n) {
  loc_t l = (loc_t){ n, n, -1, -1 };
  (void)l;
}

int main(void) {
  int guard[4] = { 0, 0, 0, 0 };
  callee(0x5A);
  printf("%d %d %d %d\n", guard[0], guard[1], guard[2], guard[3]);
  return 0;
}
