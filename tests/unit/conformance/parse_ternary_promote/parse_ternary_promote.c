// BUG: the conditional operator keeps the narrow char/short type of its arms instead of applying the usual arithmetic conversions.
// C11: 6.5.15p5 -- if both the second and third operands have arithmetic type, the usual arithmetic conversions (which include integer promotion) determine the result type.
// EXPECT: char?char and short?short both yield int -> sizeof is 4 for each.
#include <stdio.h>
int main(void) {
  char c1 = 'a', c2 = 'b';
  short s1 = 1, s2 = 2;
  printf("%d %d\n", (int)sizeof(1 ? c1 : c2), (int)sizeof(1 ? s1 : s2));
  return 0;
}
