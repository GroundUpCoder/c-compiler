// BUG: a `static` function RE-DECLARED after its definition replaces the
//      definition in scope, so the definition is dropped from the AST and the
//      symbol comes out undefined at link time. compiler.js:13368 already
//      guards the `static def; extern decl;` shape (todos/0219) but gates it
//      on the redeclaration being NON-static.
// C11: 6.7p4 / 6.2.2p4 — a declaration of an already-defined function is not a
//      new entity, and a redeclaration of an internal-linkage function keeps
//      internal linkage. clang and gcc both accept this.
// EXPECT: 42
// KNOWN-BUG: todos/0321 (pinned xfail via config.json "knownBug"). This is the
//      exact shape CPython's Argument Clinic emits — the generated
//      clinic/<file>.c.h is #included at the BOTTOM of each .c, after the
//      definitions. It caused 168 of 173 link errors in the todos/0313 probe.
#include <stdio.h>

static int helper(int x) { return x + 1; }   // DEFINITION first

static int helper(int x);                    // re-DECLARATION after it

int main(void) {
  printf("%d\n", helper(41));
  return 0;
}
