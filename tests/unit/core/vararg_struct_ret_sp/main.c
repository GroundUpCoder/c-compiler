/* Regression: a struct-returning call nested in a variadic call's
 * argument list must not leak the shadow stack pointer. The variadic
 * call paths restored SP past the deferred struct-return temps and
 * then the callNesting==0 adjustment restored them a second time,
 * walking SP upward 16 bytes per statement — in a loop this climbs
 * out of the stack region and corrupts static data. */
#include <stdio.h>

struct S { int a, b; };

struct S mk(int i) { struct S s = {i, i + 1}; return s; }
int sum(struct S s) { return s.a + s.b; }

static char *probe0, *probe1, *probe2;
void probe(char **out) { int x; *out = (char *)&x; }

int main(void) {
  probe(&probe0);
  printf("%d\n", sum(mk(0)));
  probe(&probe1);
  printf("%d\n", sum(mk(1)));
  probe(&probe2);
  printf("drift1=%d drift2=%d\n", (int)(probe1 - probe0), (int)(probe2 - probe1));

  /* The corrupting loop: each iteration used to leak 16 bytes of SP. */
  for (int i = 0; i < 100; i++) printf("%d ", sum(mk(i)));
  printf("\n");

  int total = 0;
  for (int i = 0; i < 100; i++) total += sum(mk(i));
  printf("total=%d\n", total);
  return 0;
}
