// BUG: a designator naming a member of an anonymous struct inside a union initializes the wrong union member (stores into y instead of the anonymous struct's b).
// C11: 6.7.2.1p13 -- members of an anonymous struct are members of the containing union; 6.7.9p17-19 -- .b designates that member, and other subobjects of the initialized union member are zeroed.
// EXPECT: u.b == 42; u.y aliases the anonymous struct's a, which is zero-initialized -> 0.
#include <stdio.h>
union U { int y; struct { int a; int b; }; };
int main(void) {
  union U u = { .b = 42 };
  printf("%d %d\n", u.b, u.y);
  return 0;
}
