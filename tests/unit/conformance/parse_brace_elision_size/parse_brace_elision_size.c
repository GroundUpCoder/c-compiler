// BUG: brace-elided initializers inflate the deduced size of an array of unknown size (each scalar is treated as a whole element).
// C11: 6.7.9p22, p26 -- with elided inner braces, initializers fill the members of the current subaggregate first; {1,2,3} initializes the three members of ONE struct P, {1,2} fills ONE int[2] row.
// EXPECT: a has 1 element {1,2,3}; b has 1 row {1,2}. Output: counts then the element values.
#include <stdio.h>
struct P { int x, y, z; };
struct P a[] = { 1, 2, 3 };
int b[][2] = { 1, 2 };
int main(void) {
  printf("%d %d %d %d %d %d %d\n",
    (int)(sizeof(a)/sizeof(a[0])), (int)(sizeof(b)/sizeof(b[0])),
    a[0].x, a[0].y, a[0].z, b[0][0], b[0][1]);
  return 0;
}
