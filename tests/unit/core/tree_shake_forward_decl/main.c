// Forward declaration + later definition: EIdent at the table site
// holds the prototype DFunc, but unit.staticFunctions contains the
// body-bearing definition. The bag must surface decl.definition so
// the tree-shake worklist's identity check matches.

#include <stdio.h>

static int target(int x);  // forward declaration

typedef int (*fp)(int);
static const fp table[] = { target };  // EIdent points at prototype

static int target(int x) { return x * 7; }  // definition

int main(void) {
  printf("%d\n", table[0](6));  // 42
  return 0;
}
