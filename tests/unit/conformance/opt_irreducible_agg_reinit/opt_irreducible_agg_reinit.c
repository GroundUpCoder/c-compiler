// BUG: when a function is made irreducible (goto into a loop body), loop-local aggregate initializers are hoisted/skipped, so arrays/structs/char[] accumulate across iterations instead of being re-initialized
// C11: 6.8p3 & 6.2.4p6-7 (initialization of a block-scope object is performed each time the declaration is reached in order of execution)
// EXPECT: each iteration starts from a fresh {1,2} / {3,4} / "ab", so all three lines are identical; matches native clang
#include <stdio.h>
struct Q { int a, b; };
int main(void) {
  volatile int n = 0;
  if (n) goto inside;              /* irreducible: goto into loop body */
  for (int i = 0; i < 3; i++) {
    int a[2] = {1, 2};
    struct Q q = {3, 4};
    char buf[3] = "ab";
    a[0] += 10; a[1] += 20;
    q.a += 10; q.b += 20;
    buf[0]++;
    printf("%d %d %d %d %s\n", a[0], a[1], q.a, q.b, buf);
inside: ;
  }
  return 0;
}
