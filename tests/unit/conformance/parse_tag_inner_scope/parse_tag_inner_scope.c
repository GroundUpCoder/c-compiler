// BUG: a struct tag defined inside a function body overwrites the file-scope tag of the same name.
// C11: 6.7.2.3p5 -- a struct declared with contents in an inner scope declares a new, distinct type; the outer tag's type is unchanged.
// EXPECT: file-scope struct S has one int member -> sizeof 4; the block-scope struct S has char buf[100] -> sizeof 100.
#include <stdio.h>
struct S { int a; };
int f(void) { struct S { char buf[100]; } t; return (int)sizeof(t); }
int main(void) {
  printf("%d %d\n", (int)sizeof(struct S), f());
  return 0;
}
