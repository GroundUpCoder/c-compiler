// BUG: adjacent bit-fields of DIFFERENT declared types get separate storage
//      units. compiler.js opens a fresh allocation unit whenever the declared
//      type of an adjacent bit-field changes, instead of packing them into one
//      shared aligned unit (Itanium/psABI, what clang does). Diverges on
//      sizeof AND offsetof of following members.
// C11: 6.7.2.1p11 (unit packing is implementation-defined) — but compiler.js
//      otherwise tracks the clang wasm32 ABI, so an ABI mismatch here breaks
//      arrays/memcpy/serialization against clang-built code.
// EXPECT: struct A{char a:4; int b:4; int tail;} -> sizeof 8, offsetof(tail) 4
//      (both int-width, valid on ILP32 and LP64). compiler.js: 12 and 8.
// KNOWN-BUG: todos/0190 (pinned xfail; the layout allocator keys "current unit"
//      on the field's declared type and restarts on a type change).
#include <stdio.h>
#include <stddef.h>
struct A { char a:4; int b:4; int tail; };
int main(void) {
  printf("%d %d\n", (int)sizeof(struct A), (int)offsetof(struct A, tail));
  return 0;
}
