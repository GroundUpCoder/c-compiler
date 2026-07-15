// BUG: a DECIMAL integer constant whose value exceeds LLONG_MAX but fits in
//      unsigned long long is silently given SIGNED long long type (the value
//      wraps negative), with no diagnostic. This silently flips the signedness
//      of the surrounding usual-arithmetic-conversions -> wrong arithmetic and
//      comparisons ("compiles and links but computes the wrong result").
// C11: 6.4.4.1p5 — a decimal constant's candidate type list is signed-only;
//      gcc/clang extend to unsigned long long (with a warning). The HEX path
//      in compiler.js is already correct; only the decimal path is wrong.
// EXPECT: 18446744073709551615 (UINT64_MAX) compares > 0 as unsigned (cmp=1)
//      and 18446744073709551615 % 10 == 5. compiler.js: cmp=0, mod wraps.
// KNOWN-BUG: todos/0192 (pinned xfail; the constant-typing path picks signed
//      long long on int/long overflow without the 6.4.4.1p5 unsigned fallback).
#include <stdio.h>
int main(void) {
  printf("cmp=%d\n", 18446744073709551615 > 0);
  printf("mod=%llu\n", 18446744073709551615 % 10);
  return 0;
}
