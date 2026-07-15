// BUG: `#__VA_ARGS__` drops the whitespace immediately BEFORE an
//      argument-separating comma. The arg-separating commas are re-synthesized
//      fresh during __VA_ARGS__ reconstruction and never carry the original
//      leading-whitespace bit, so stringize emits no space before them.
// C11: 6.10.3.2 (# operator: white space between tokens becomes a single
//      space; leading/trailing stripped). Space AFTER a comma is preserved;
//      only the space BEFORE the delimiter comma is lost.
// EXPECT: S(a , b) stringizes to "a , b". compiler.js: "a, b".
// KNOWN-BUG: todos/0196 (pinned xfail; root cause ~compiler.js:1445/1523.
//      Cosmetic — affects #-stringized log/assert message text only).
#include <stdio.h>
#define S(...) #__VA_ARGS__
int main(void) {
  printf("[%s]\n", S(a , b));
  return 0;
}
