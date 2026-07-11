// BUG: a GCC __attribute__ trailing a function-parameter declarator, e.g.
//      f(int x __attribute__((unused))), was a hard parse error — the
//      parameter parser consumed the declarator but not a trailing attribute,
//      so real-world C (puNES's core, todos/0088) failed to compile.
// C11: 6.7.6 declarators; __attribute__ is a GCC extension gcc/clang accept in
//      this position and it never affects the parameter's type or ABI.
// EXPECT: the attribute parses and is ignored; the function runs normally and
//         add(41, 2, 3) returns 42.
#include <stdio.h>

static int add(int a, int b __attribute__((unused)),
               int c __attribute__((unused))) {
  return a + 1;
}

int main(void) {
  printf("%d\n", add(41, 2, 3));
  return 0;
}
