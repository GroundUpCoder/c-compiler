// BUG: an `enum` bit-field whose enum has only non-negative enumerators is read
//      SIGNED (sign-extended), yielding a wrong observed value. clang gives the
//      enum bit-field an unsigned underlying type and zero-extends it.
// C11: 6.7.2.1p10 (bit-field value), 6.7.2.2p4 (enum compatible type is
//      implementation-defined; clang/gcc pick unsigned int when every
//      enumerator is >= 0). compiler.js otherwise tracks the clang wasm32 ABI.
// EXPECT: A3 == 3 stored in a 2-bit enum field reads back 3, not -1.
// KNOWN-BUG: todos/0189 (pinned xfail via config.json "knownBug"; the bitfield
//      read path sign-extends every non-`unsigned` declared field type).
#include <stdio.h>
enum NN { A0, A1, A2, A3 };          // all enumerators >= 0
int main(void) {
  struct S { enum NN x:2; } s;
  s.x = A3;                          // 3 == binary 11
  printf("%d\n", s.x);
  return 0;
}
