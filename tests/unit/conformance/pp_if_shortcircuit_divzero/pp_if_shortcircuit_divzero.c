// BUG: the #if evaluator computes 1/0 even though && / || short-circuit,
//      crashing the compiler (uncaught division-by-zero throw).
// C11: 6.5.13p4 and 6.5.14p4 — && and || guarantee the right operand is not
//      evaluated when the left operand already determines the result; 6.10.1p4
//      gives #if the same semantics.
// EXPECT: 0 && ... is false (AND:off), 1 || ... is true (OR:on), and the
//         divisions by zero are never evaluated.
#include <stdio.h>

#if 0 && 1/0
#define A "AND:on"
#else
#define A "AND:off"
#endif
#if 1 || 1/0
#define B "OR:on"
#else
#define B "OR:off"
#endif

int main(void) {
  puts(A);
  puts(B);
  return 0;
}
