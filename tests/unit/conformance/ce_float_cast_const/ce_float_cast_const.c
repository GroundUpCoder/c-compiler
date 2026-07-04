// BUG: constant evaluation performs INTEGER division on float/double-typed
//      subexpressions, so (float)7 / 2 folds to 3 instead of 3.5 — the static
//      initializer, the array bound, and the folded local all come out 6/24/6.
// C11: 6.3.1.8 (usual arithmetic conversions: 7/2 is done in float when one
//      operand is float), 6.6p6/p8 (arithmetic constant expressions evaluate
//      per the semantics), 6.3.1.4 ((int)3.5*2 -> (int)7.0 == 7).
// EXPECT: (int)((float)7 / 2 * 2) == (int)7.0f == 7; the array has 7 ints ->
//         sizeof == 28; same for the double version -> 7.
#include <stdio.h>

static int h = (int)((float)7 / 2 * 2);

int main(void) {
  printf("%d\n", h);
  int arr[(int)((float)7 / 2 * 2)];
  printf("%d\n", (int)sizeof(arr));
  int v = (int)((double)7 / 2 * 2);
  printf("%d\n", v);
  return 0;
}
