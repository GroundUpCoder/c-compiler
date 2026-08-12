// BUG: guard for the #642 arity check: a variadic macro may legally
//      receive ZERO trailing arguments — L(5) supplies only the named
//      parameter and must not trip the too-few diagnostic; SUM0() is a
//      zero-parameter variadic invoked with nothing at all.
// C11: 6.10.3p4 with the C23/GNU zero-trailing relaxation (clang/gcc
//      accept it; __VA_OPT__ exists precisely for this case).
// EXPECT: L(5)==5, L(5,6)==11, SUM0()==0, SUM0(1,2) -> `(0 + 1, 2)` == 2
//      (comma expression), GNU comma deletion V(...) prints both lines.
#include <stdio.h>

#define L(head, ...) (head __VA_OPT__(+) __VA_ARGS__)
#define SUM0(...) (0 __VA_OPT__(+) __VA_ARGS__)
#define V(fmt, ...) printf(fmt, ##__VA_ARGS__)

int main(void) {
  printf("%d\n", L(5));
  printf("%d\n", L(5, 6));
  printf("%d\n", SUM0());
  printf("%d\n", SUM0(1, 2));
  V("plain\n");
  V("%d\n", 42);
  return 0;
}
