/* Assignment between pointers to same-size integer types of different
 * signedness is strictly a C constraint violation, but gcc and clang
 * accept it (default-off warning) and real code relies on it — Csmith
 * seed 2 was the trigger. The representation is identical either way. */
#include <stdio.h>

int main(void) {
  unsigned long long u = 0x1122334455667788ULL;
  long long *p = &u;             /* ULL* -> LL*  */
  unsigned long long *q;
  long long s = -5;
  q = &s;                        /* LL*  -> ULL* */
  printf("%llx %llx\n", (unsigned long long)*p, *q);

  unsigned int ui = 7;
  int *ip = &ui;
  printf("%d\n", *ip);

  /* different sizes must still be rejected — guarded by
     arity/conversion tests elsewhere; here just same-size cases */
  return 0;
}
