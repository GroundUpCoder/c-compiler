// BUG: ++/-- on a _Bool accessed through memory (pointer or struct field) stores raw 2/255 instead of re-normalizing to 0/1
// C11: 6.5.2.4p2 & 6.5.3.1p2 (++/-- are +=1/-=1), 6.3.1.2p1 (any nonzero value converts to _Bool as 1)
// EXPECT: _Bool 1 after ++ is 1 (1+1 -> nonzero -> 1); _Bool 0 after -- is 1 (0-1 -> nonzero -> 1); same via struct field; matches native clang
#include <stdio.h>
struct S { _Bool f; };
int main(void) {
  _Bool b = 1;
  _Bool *p = &b;
  (*p)++;
  printf("A %d\n", (int)b);
  b = 0;
  (*p)--;
  printf("B %d\n", (int)b);
  struct S s = {1};
  struct S *sp = &s;
  sp->f++;
  printf("C %d\n", (int)sp->f);
  return 0;
}
