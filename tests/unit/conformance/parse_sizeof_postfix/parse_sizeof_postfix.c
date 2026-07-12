// BUG: `sizeof (a)[0]` failed to parse ("Expected ')'"): after consuming a
//      parenthesized non-type operand, the parser returned the sizeof node
//      immediately instead of letting postfix operators keep binding to the
//      operand — rejecting the suckless LEN(a) = sizeof(a) / sizeof(a)[0]
//      idiom (hit vendoring sent, todos/0119).
// C11: 6.5.3 (unary-expression: `sizeof unary-expression`) + 6.5.2 (a
//      postfix-expression can be `( expression )` followed by [] . -> ):
//      sizeof(a)[0] parses as sizeof((a)[0]), NOT (sizeof(a))[0].
// EXPECT: 3 (array length), then element/member sizes 4/4/4.
#include <stdio.h>

static const char *strs[] = {"alpha", "beta", "gamma"};
struct pt { int x, y; };

int main(void) {
  int n[4] = {1, 2, 3, 4};
  struct pt p = {11, 22};
  struct pt *pp = &p;
  printf("%d\n", (int)(sizeof(strs) / sizeof(strs)[0]));
  printf("%d\n", (int)sizeof(n)[0]);
  printf("%d\n", (int)sizeof(p).x);
  printf("%d\n", (int)sizeof(pp)->y);
  return 0;
}
