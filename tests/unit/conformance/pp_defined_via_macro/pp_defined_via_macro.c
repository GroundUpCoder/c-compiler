// BUG: a `defined` operator produced BY macro expansion inside `#if` evaluates
//      wrong. `#define D defined` then `#if D(FOO)` -> gcc/clang expand D to
//      `defined`, treat it as defined(FOO)==1 (true branch); compiler.js
//      evaluates it as 0 (false branch).
// C11: 6.10.1p4 — this is strictly UNDEFINED BEHAVIOR (defined via expansion),
//      so compiler.js is technically conforming, but gcc AND clang both
//      document + implement the expansion, and portable-ish config headers
//      rely on it. Filed as a portability trap.
// EXPECT: branch=true (D expands to defined, defined(FOO) is 1).
//      compiler.js: branch=false.
// KNOWN-BUG: todos/0195 (pinned xfail).
#include <stdio.h>
#define D defined
#define FOO 1
int main(void) {
#if D(FOO)
  printf("branch=true\n");
#else
  printf("branch=false\n");
#endif
  return 0;
}
