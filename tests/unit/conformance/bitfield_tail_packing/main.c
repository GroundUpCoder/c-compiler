// BUG: closing a bit-field storage unit advanced the running offset by the
//      WHOLE declared unit width (size += unit size) instead of just past the
//      used bits, so a following member never packed into the unit's unused
//      tail bytes. sizeof AND the offset of every member after a bit-field
//      run diverged from the clang wasm32 ABI:
//      struct {unsigned a:3; char c;} was sizeof 8 / offsetof(c) 4; clang
//      says 4 / 1. Packed structs diverged too (sizeof 5 vs clang's 2).
// C11: 6.7.2.1p11 (placement of bit-fields is implementation-defined) —
//      compiler.js otherwise tracks the clang wasm32 ABI.
// EXPECT: every line below matches clang --target=wasm32 (record layouts
//      verified with -Xclang -fdump-record-layouts), plus value round-trips
//      proving the narrowed RMW window preserves tail-packed neighbours.
#include <stdio.h>
#include <string.h>
#include <stddef.h>

struct A1 { unsigned a:3; char c; };                       // 4/4, c@1
struct A2 { unsigned a:1; unsigned b:1; int c; };          // 8/4, c@4
struct A3 { unsigned a:3; char c; short s; };              // 4/4, c@1 s@2
struct A4 { char a:3; char c; };                           // 2/1, c@1
struct A6 { unsigned a:32; char c; };                      // 8/4, c@4 (full-width)
struct S9 { int a:8; short s; };                           // 4/4, s@2
struct S10 { unsigned a:19; char c; };                     // 4/4, c@3
struct S64 { unsigned long long a:5; unsigned long long b:40; char c; }; // 8/8, c@6
struct __attribute__((packed)) A8 { unsigned a:3; char c; }; // 2/1, c@1

static struct A1 g1 = {5, 'x'};            // static init into a shared unit
static struct A8 g8[2] = {{3, 'p'}, {7, 'q'}};

#define P(T, M) printf(#T " %d %d %d\n", (int)sizeof(struct T), \
    (int)_Alignof(struct T), (int)offsetof(struct T, M))

int main(void) {
  P(A1, c); P(A2, c); P(A3, s); P(A4, c); P(A6, c);
  P(S9, s); P(S10, c); P(S64, c); P(A8, c);

  printf("g1 %u %c\n", g1.a, g1.c);
  printf("g8 %u %c %u %c\n", g8[0].a, g8[0].c, g8[1].a, g8[1].c);

  // The bit-field RMW must not clobber the member packed into the unit's
  // tail, and a store to that member must not clobber the bit-field.
  struct A1 x; memset(&x, 0, sizeof x);
  x.c = 'z'; x.a = 6;
  printf("x %u %c\n", x.a, x.c);
  x.a = 1; x.c = 'w';
  printf("x %u %c\n", x.a, x.c);
  unsigned char raw[sizeof x];
  memcpy(raw, &x, sizeof x);
  printf("raw %02x %02x %02x %02x\n", raw[0], raw[1], raw[2], raw[3]);

  // Packed: adjacent 2-byte elements — the access window must stay inside
  // each element (a declared-unit-wide RMW would straddle the neighbour).
  struct A8 p[2]; memset(p, 0, sizeof p);
  p[0].c = 'k'; p[1].a = 5; p[0].a = 2; p[1].c = 'm';
  printf("p %u %c %u %c %d\n", p[0].a, p[0].c, p[1].a, p[1].c, (int)sizeof p);

  // 64-bit unit with a tail-packed char at offset 6.
  struct S64 y; memset(&y, 0, sizeof y);
  y.c = 'v'; y.b = 0x123456789AULL; y.a = 21;
  printf("y %llu %llu %c\n", (unsigned long long)y.a, (unsigned long long)y.b, y.c);
  return 0;
}
