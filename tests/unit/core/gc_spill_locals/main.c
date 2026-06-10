/* --gc-spill-locals forces scalar locals into the shadow stack so
 * conservative garbage collectors can find roots by scanning linear
 * memory (wasm locals are invisible to any scan — micropython's gc
 * swept live objects whose only reference sat in a wasm local).
 * This test guards the basics under the flag, especially that alloca()
 * keeps working: a function using the alloca intrinsic must NOT get a
 * spill frame, or its epilogue would free the allocation. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <alloca.h>

int vsum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  int t = 0;
  for (int i = 0; i < n; i++) t += va_arg(ap, int);
  va_end(ap);
  return t;
}

struct P { int x, y; };
struct P mk(int i) { struct P p = {i, i * 2}; return p; }

int use_alloca(int n) {
  char *buf = alloca(n);
  memset(buf, 'x', n - 1);
  buf[n - 1] = 0;
  char *buf2 = alloca(8);
  strcpy(buf2, "second");
  return (int)strlen(buf) + (buf2[0] == 's');
}

int main(void) {
  int a = 5;
  int *pa = &a;
  printf("%d %d\n", *pa, vsum(3, 1, 2, 3));
  struct P p = mk(7);
  printf("%d %d\n", p.x, p.y);
  printf("%d\n", use_alloca(10));
  for (int i = 0; i < 3; i++) printf("%d ", use_alloca(4 + i));
  printf("\n");
  return 0;
}
