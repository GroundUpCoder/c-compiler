// BUG: _Alignas / __attribute__((aligned)) on a UNION member was silently
//      ignored — computeUnionLayout never consulted requestedAlignment
//      (the struct path did), so neither the union's alignment nor its
//      alignment-rounded size honoured it. union {char c
//      __attribute__((aligned(16)));} gave 1/1; clang wasm32 says 16/16.
// C11: 6.7.5 (_Alignas applies to the member object; the union's alignment
//      is at least that of every member).
// EXPECT: numbers verified with clang --target=wasm32
//      -Xclang -fdump-record-layouts (note U3: size 6 rounds up to 8).
#include <stdio.h>
#include <stdint.h>

union U1 { char c __attribute__((aligned(16))); };   // 16/16
union U2 { _Alignas(8) char c; int x; };             // 8/8
union U3 { char c[6] __attribute__((aligned(4))); }; // 8/4 (size rounds up)

static union U1 gu1;

int main(void) {
  printf("U1 %d %d\n", (int)sizeof(union U1), (int)_Alignof(union U1));
  printf("U2 %d %d\n", (int)sizeof(union U2), (int)_Alignof(union U2));
  printf("U3 %d %d\n", (int)sizeof(union U3), (int)_Alignof(union U3));
  printf("addr %d\n", (int)((uintptr_t)&gu1 % 16));
  union U2 u; u.x = 0x01020304;   // wasm is little-endian: c aliases the low byte
  printf("pun %d\n", (int)u.c);
  return 0;
}
