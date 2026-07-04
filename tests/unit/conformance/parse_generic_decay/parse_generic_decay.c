// BUG: _Generic does not apply lvalue conversion / array-to-pointer decay to the controlling expression, so array-typed operands never match the pointer association.
// C11: 6.5.1.1 (as clarified by C17 DR 481) -- the controlling expression undergoes lvalue conversion; "hi" has type char[3] -> char*, arr has type int[3] -> int*.
// EXPECT: both selections pick the pointer association -> 1 1.
#include <stdio.h>
int main(void) {
  int arr[3];
  printf("%d %d\n",
    _Generic("hi", char*: 1, default: 2),
    _Generic(arr, int*: 1, default: 2));
  return 0;
}
