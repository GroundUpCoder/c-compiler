// BUG: a `static` function RE-DECLARED after its definition replaced the
//      definition in scope, so the definition was dropped from the AST and the
//      symbol came out undefined at link time. The drop guard already covered
//      the `static def; extern decl;` shape (todos/0219) but gated it on the
//      redeclaration being NON-static.
// C11: 6.7p4 / 6.2.2p4 — a declaration of an already-defined function is not a
//      new entity, and a redeclaration of an internal-linkage function keeps
//      internal linkage. clang and gcc both accept this.
// EXPECT: 42
// FIXED by todos/0321 — the `specs.storageClass !== STATIC` condition was
//      removed (it guarded nothing: the same repro fails on the tree from
//      BEFORE todos/0219 added the block). Was a pinned xfail; the
//      "knownBug" tag is gone and this is now a permanent regression guard.
//      This is the exact shape CPython's Argument Clinic emits — the generated
//      clinic/<file>.c.h is #included at the BOTTOM of each .c, after the
//      definitions. It caused 168 of 173 link errors in the todos/0313 probe.
//      The eight-ordering matrix lives in link_static_redecl_after_def.
#include <stdio.h>

static int helper(int x) { return x + 1; }   // DEFINITION first

static int helper(int x);                    // re-DECLARATION after it

int main(void) {
  printf("%d\n", helper(41));
  return 0;
}
