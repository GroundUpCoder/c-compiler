// BUG: __attribute__((aligned(N))) with any argument crashed the parser
//      ("this._constEvalInt is not a function" — the attribute handler called
//      a nonexistent method instead of the free constEvalInt helper). Every
//      declarator position was affected; found via busybox's ALIGN1 idiom.
// C11: n/a (GCC common variable attribute "aligned"); alignment request must
//      be honored per GCC docs 6.34.1 (can only increase alignment)
// EXPECT: aligned(N) parses in after-array-declarator, before-declarator, and
//         local positions; requested alignment is observable; matches clang
#include <stdio.h>
#include <stdint.h>

static const char a1[] __attribute__((aligned(1))) = "a"; // busybox ALIGN1 position
static const char a64[3] __attribute__((aligned(64))) = "hi";
static __attribute__((aligned(32))) int s32 = 5;
__attribute__((aligned(1 << 4))) static short e16 = 7; // const-expr argument

int main(void) {
  int local __attribute__((aligned(64))) = 9;
  printf("%d %d %d %d\n",
         (int)((uintptr_t)a64 % 64 == 0),
         (int)((uintptr_t)&s32 % 32 == 0),
         (int)((uintptr_t)&e16 % 16 == 0),
         (int)((uintptr_t)&local % 64 == 0));
  printf("%c %s %d %d\n", a1[0], a64, s32, e16);
  return 0;
}
