// BUG: two zero-width bit-field divergences from clang/GCC, exposed while
//      fixing the tail-packing bug (same layout-close path):
//      1. `:0` contributed its declared type's alignment to the STRUCT's
//         alignment — clang gives struct {char a:3; int :0; char c;}
//         align 1 / sizeof 5; compiler.js said align 4 / sizeof 8.
//      2. inside __attribute__((packed)) the `:0` boundary was neutered
//         (member alignment forced to 1) — clang/GCC keep the force-to-
//         boundary effect of `:0` even in a packed struct.
// C11: 6.7.2.1p12 (zero-width bit-field: no further bit-field packs into
//      the same unit); boundary/alignment behaviour matches clang wasm32.
// EXPECT: numbers below verified with clang --target=wasm32
//      -Xclang -fdump-record-layouts.
#include <stdio.h>
#include <stddef.h>

struct Z1 { char a:3; int :0; char c; };        // 5/1, c@4
struct Z2 { char a:3; long long :0; char c; };  // 9/1, c@8
struct __attribute__((packed)) Z3 { char a:3; int :0; char c; }; // 5/1, c@4
struct Z4 { int :0; char c; };                  // 1/1, c@0
struct Z5 { unsigned a:3; unsigned :0; char c; }; // 8/4, c@4 (align from `a`)

#define P(T, M) printf(#T " %d %d %d\n", (int)sizeof(struct T), \
    (int)_Alignof(struct T), (int)offsetof(struct T, M))

int main(void) {
  P(Z1, c); P(Z2, c); P(Z3, c); P(Z4, c); P(Z5, c);
  return 0;
}
