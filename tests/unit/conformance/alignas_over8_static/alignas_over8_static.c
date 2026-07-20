// BUG: `_Alignas(N)` with N > 8 was rejected regardless of storage class
//      ("exceeds maximum supported alignment of 8"); clang accepts it.
// C11: 6.7.5 (_Alignas), 6.2.8 (alignment). Static storage over-aligns in the
//      data section (link-time property); automatic storage over-aligns on the
//      frame — the same path the already-uncapped __attribute__((aligned(N)))
//      uses, so `_Alignas` no longer caps at 8 either (todos/0194).
// EXPECT: `_Alignas(32) char g[4];` (static) and `_Alignas(64) int l;`
//      (automatic) both compile and are correctly over-aligned -> all 1.
//      compiler.js used to reject both at compile time (rejects-valid).
#include <stdio.h>
#include <stdint.h>
_Alignas(32) char g[4];
static _Alignas(128) char sg[2];
int main(void) {
  _Alignas(64) int l = 0;
  static _Alignas(256) char sl[3];
  sl[0] = 1;
  printf("%d %d %d %d\n",
         (int)((uintptr_t)&g % 32 == 0),
         (int)((uintptr_t)&sg % 128 == 0),
         (int)((uintptr_t)&l % 64 == 0),
         (int)((uintptr_t)&sl % 256 == 0));
  return 0;
}
