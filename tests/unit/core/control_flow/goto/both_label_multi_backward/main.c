// Multiple backward gotos to the same BOTH label. Each goto site should
// get its own copy of the inlined body. After all are inlined, the label
// has no remaining backward gotos and demotes to FORWARD-only.
#include <stdio.h>

int classify(int op, int v) {
  int code = 0;
  if (op == 1) goto sink;          // forward
  if (op == 2) goto sink;          // forward
  return v;

 sink:
  return -code - 100;

 alt1:
  code = 10;
  goto sink;                       // backward #1

 alt2:
  code = 20;
  goto sink;                       // backward #2

 alt3:
  code = 30;
  goto sink;                       // backward #3
}

/* alt1/alt2/alt3 are unreachable in this test, but they exercise the
 * inliner's handling of multiple backward gotos to the same label. */

int main(void) {
  printf("%d\n", classify(0, 42));   /* 42 (no goto) */
  printf("%d\n", classify(1, 0));    /* sink → return -0-100 = -100 */
  printf("%d\n", classify(2, 0));    /* same */
  return 0;
}
