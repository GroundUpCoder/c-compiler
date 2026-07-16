// BUG: __COUNTER__ (GNU extension, common in unique-identifier token
//      pasting) was not implemented — an undeclared identifier.
// C11: n/a (GNU extension, matches gcc/clang: expands to 0, 1, 2, ...
//      incrementing at each expansion, per translation unit).
// EXPECT: sequences from 0; the two-level CAT idiom pastes the expanded
//      value, so id_0 / id_1 are distinct globals.
#include <stdio.h>
#define CAT_(a, b) a##b
#define CAT(a, b) CAT_(a, b)
#define UNIQ CAT(id_, __COUNTER__)
int UNIQ = 10;
int UNIQ = 20;
int main(void) {
  printf("%d %d %d\n", id_0, id_1, __COUNTER__);
  return 0;
}
