// BUG: the GNU __extension__ keyword (a semantic no-op whose only job is to
//      suppress -pedantic diagnostics on the construct that follows) parsed
//      as an ordinary identifier: "Undeclared identifier '__extension__'".
//      It is pervasive in glibc headers and generated C; in CPython it
//      blocked all 8 hashlib TUs via Modules/_hacl's krml headers.
// C11: not ISO C — GNU extension. Accepted exactly where gcc/clang accept
//      it: before an external declaration, before a block-scope declaration
//      or expression statement, in cast-expression position (which covers
//      the compound-literal shape), and before a struct member declaration
//      (CPython object.h's anonymous-union shape). It is NOT accepted
//      before a plain initializer brace (clang rejects that too).
// EXPECT: identical behavior with and without every __extension__ below;
//         prints the component values and their sum.
#include <stdio.h>

/* before an external declaration, typedef and object flavors */
__extension__ typedef struct { int lo; int hi; } pair_t;
__extension__ int g0 = 1;

/* before a struct member declaration (the CPython object.h shape) */
struct s { __extension__ union { int a; unsigned b; } u; int tail; };

int main(void) {
  /* before a block-scope declaration */
  __extension__ int x = 2;
  /* before an expression statement */
  __extension__ x = x + 1;
  /* in expression (cast-expression) position inside an initializer */
  int y = __extension__ 4;
  /* before a compound literal — the exact CPython _hacl shape */
  pair_t p = __extension__ (pair_t){ .lo = 5, .hi = 6 };
  int *q = __extension__ (int[]){ 7, 8 };
  /* repeated application is allowed */
  __extension__ __extension__ int z = 9;
  struct s sv = { .u = { .a = 10 }, .tail = 11 };
  int sum = g0 + x + y + p.lo + p.hi + q[0] + q[1] + z + sv.u.a + sv.tail;
  printf("%d %d %d %d %d %d %d %d %d %d\n",
         g0, x, y, p.lo, p.hi, q[0], q[1], z, sv.u.a, sv.tail);
  printf("sum=%d\n", sum);
  return 0;
}
