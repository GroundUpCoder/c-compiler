/* Regression: a static initializer taking the address of a NESTED
 * member chain (&g.inner.field, &g.arr[i].field) silently emitted 0 —
 * constEvalAddr handled EArrow but not lvalue EMember/ESubscript, and
 * the writer treated the failed fold as zero. Found via micropython's
 * sys module ROM table (&mp_state_ctx.vm.mp_sys_argv_obj == NULL, so
 * sys.argv raised AttributeError). */
#include <stdio.h>

struct Inner { int a; int b; };
struct Mid { int pad; struct Inner inner; struct Inner arr[3]; };
struct Big { int head[7]; struct Mid mid; };

extern struct Big ext_big;          /* cross-TU */
static struct Big loc_big;          /* same-TU  */

void *table[] = {
  &ext_big,
  &ext_big.mid.inner,
  &ext_big.mid.inner.b,
  &ext_big.mid.arr[2].b,
  &loc_big.mid.inner.b,
  &loc_big.mid.arr[1].a,
};

int main(void) {
  printf("%d\n", table[0] == (void *)&ext_big);
  printf("%d\n", table[1] == (void *)&ext_big.mid.inner);
  printf("%d\n", table[2] == (void *)&ext_big.mid.inner.b);
  printf("%d\n", table[3] == (void *)&ext_big.mid.arr[2].b);
  printf("%d\n", table[4] == (void *)&loc_big.mid.inner.b);
  printf("%d\n", table[5] == (void *)&loc_big.mid.arr[1].a);
  printf("%d\n", table[2] != 0 && table[3] != 0);
  return 0;
}
