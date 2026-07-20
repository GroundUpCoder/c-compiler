// BUG: `#pragma pack(N)` / `push` / `pop` were silently ignored (compiler.js
//      "Other pragmas silently ignored"). __attribute__((packed)) IS honored,
//      but #pragma pack dropped on the floor with no warning, so the struct
//      silently got default alignment.
// C11: 6.10.6 (pragmas) + the universal MSVC/gcc/clang #pragma pack extension.
// EXPECT: pack(1) -> sizeof(struct P) 5; pack(2) -> sizeof(struct Q) 6; the
//      push/pop stack restores the enclosing value; #pragma pack does not
//      lower an explicit __attribute__((packed)) (which stays byte-tight).
//      compiler.js used to give 8 for P and Q (default alignment; no
//      diagnostic).
// FIXED: todos/0191 — the preprocessor emits a pack marker the parser threads
//      into computeStructLayout as an alignment cap. All sizes verified
//      against clang.
#include <stdio.h>
#include <stddef.h>
#pragma pack(1)
struct P { char c; int i; };            // clang: 5
#pragma pack(2)
struct Q { char c; int i; };            // clang: 6
#pragma pack()
struct R { char c; int i; };            // natural -> 8

#pragma pack(push, 1)
struct S1 { char c; int i; short s; };  // 7
#pragma pack(push, 2)
struct S2 { char c; int i; };           // 6
#pragma pack(pop)
struct S3 { char c; int i; };           // back to pack(1) -> 5
#pragma pack(pop)
struct S4 { char c; int i; };           // natural -> 8

struct __attribute__((packed)) AP { char c; int i; };  // 5

int main(void) {
  printf("%d %d %d\n", (int)sizeof(struct P), (int)sizeof(struct Q), (int)sizeof(struct R));
  printf("%d %d %d %d\n", (int)sizeof(struct S1), (int)sizeof(struct S2),
         (int)sizeof(struct S3), (int)sizeof(struct S4));
  printf("%d\n", (int)sizeof(struct AP));
  return 0;
}
