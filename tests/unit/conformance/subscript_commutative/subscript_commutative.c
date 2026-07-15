// BUG: commutative subscript `N[arr]` is rejected. E1[E2] === *(E1+E2) and
//      addition is commutative, so `1[arr]` is standard C equal to `arr[1]`.
//      compiler.js rejects it deliberately ("Commutative subscript ... is not
//      supported; write arr[0] instead").
// C11: 6.5.2.1p2 (the subscript operator is defined via *(E1+(E2)), symmetric).
// EXPECT: with int arr[3]={1,2,3}, `1[arr]` yields 2 (== arr[1]).
//      compiler.js: parse error (rejects-valid).
// KNOWN-BUG: todos/0193 (pinned xfail; deliberate rejection ~compiler.js:4937).
#include <stdio.h>
int main(void) {
  int arr[3] = {1, 2, 3};
  printf("%d\n", 1[arr]);   // clang: 2
  return 0;
}
