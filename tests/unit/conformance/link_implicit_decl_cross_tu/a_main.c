// BUG: calling an undeclared function whose definition lives in another translation unit linked cleanly, then codegen crashed (internal compiler error: "emitExpr: function 'f' not found") — the implicit decl never reached the linker, so its .definition was never stitched
// C11: C89 6.3.2.2 — an implicit declaration `extern int ident()` is created at the call; --allow-old-c opts into that C89 behavior (bison-generated grammar.c calling yylex() defined in scanner.c is the real-world shape)
// EXPECT: cross-TU calls through implicit decls resolve at link like explicit `extern int f();` decls — no-arg and promoted-int-arg flavors; matches native clang -std=c89
#include <stdio.h>
int main(void) {
  printf("%d\n", f());
  printf("%d\n", g(21));
  return 0;
}
