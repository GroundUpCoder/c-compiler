// BUG: a block-scope `extern int x;` re-declaring a visible file-scope
//      `static int x` failed to link ("Undefined symbol 'x'") — the extern
//      local was routed to the external link scope instead of binding the
//      visible internal-linkage object.
// C11: 6.2.2p4 — the block-scope extern declaration inherits the visible
//      file-scope static's internal linkage and denotes the same entity.
// EXPECT: clang-verified output below.
#include <stdio.h>

static int x = 4;
static int f(void) { return 7; }

static void bump(void) {
  extern int x;            /* binds the file-scope static */
  x += 10;
}

int main(void) {
  extern int x;
  extern int f(void);      /* block-scope function re-declaration */
  bump();
  {
    extern int x;          /* nested block, same rule */
    printf("%d %d\n", x, f());
  }
  return 0;
}
