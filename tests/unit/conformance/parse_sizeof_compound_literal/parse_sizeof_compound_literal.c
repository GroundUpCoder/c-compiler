// BUG: `sizeof (int[]){1,2,3}` fails to parse -- the parser sees `sizeof (type)` and does not accept the compound-literal braces that follow.
// C11: 6.5.3 grammar -- `sizeof unary-expression`; a compound literal (6.5.2.5) is a postfix-expression, so the whole operand is the compound literal, not a parenthesized type.
// EXPECT: (int[]){1,2,3} completes to type int[3] -> sizeof is 12.
#include <stdio.h>
int main(void) {
  printf("%d\n", (int)sizeof (int[]){1,2,3});
  return 0;
}
