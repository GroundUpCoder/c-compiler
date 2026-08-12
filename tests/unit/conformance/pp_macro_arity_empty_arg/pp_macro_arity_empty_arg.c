// BUG: guard for the #642 arity check: an EMPTY argument is still an
//      argument (it "consists of no preprocessing tokens"), so P(,+,)
//      passes THREE arguments and must not trip the too-few diagnostic.
// C11: 6.10.3p4 — arguments may consist of no preprocessing tokens;
//      6.10.3.1 — the parameter is then replaced by nothing.
// EXPECT: P(1,+,2) -> `1 + 2` == 3; P(,+,) 3 -> `+ 3` (unary plus) == 3;
//         CAT(x1,) -> `x1` == 7.
#include <stdio.h>

#define P(a,b,c) a b c
#define CAT(a,b) a##b

int main(void) {
  int x1 = 7;
  printf("%d\n", P(1, +, 2));
  printf("%d\n", P(,+,) 3);
  printf("%d\n", CAT(x1,));
  return 0;
}
