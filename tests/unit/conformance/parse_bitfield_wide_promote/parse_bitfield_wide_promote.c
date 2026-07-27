// BUG: a bit-field WIDER than int was promoted to unsigned int anyway, so a binary operand read only its low 32 bits -- `u.p.frc == 0` was true for every NaN (todos/0356: MicroPython's IEEE-754 classifier then raised OverflowError where ValueError is owed).
// C11: 6.3.1.1p2 -- the integer promotions reach a bit-field only when int/unsigned int can represent its values as restricted by the width; all other types are unchanged, so a 33..64-bit field keeps its declared type.
// EXPECT: 64-bit values survive comparison, shift and division; a 32-bit-wide `long long` field promotes to (signed) int.
#include <stdio.h>
#include <stdint.h>

struct S {
  uint64_t u33 : 33;
  int64_t s33 : 33;
  uint64_t u52 : 52;
  uint64_t u64 : 64;
  int64_t s32 : 32;
  uint64_t u32 : 32;
};

int main(void) {
  struct S s = {0};
  // Only the high half is set: an operand truncated to 32 bits reads zero.
  s.u33 = 1ull << 32;
  s.s33 = -(1ll << 32);
  s.u52 = 1ull << 51;
  s.u64 = 1ull << 40;
  printf("%d %d\n", s.u33 == 0, s.u33 != 0);
  printf("%d %d\n", s.s33 < 0, s.u52 > 0);
  printf("%d %d\n", s.u64 == 0, s.u52 + 0 == 0);
  printf("%llx\n", (unsigned long long)(s.u52 >> 1));
  printf("%llx\n", (unsigned long long)(s.u52 / 2));
  // A field exactly int-wide still promotes: signed -> int, unsigned ->
  // unsigned int (int cannot represent 2^32-1).
  s.s32 = -1;
  s.u32 = 0xFFFFFFFFu;
  printf("%d %d\n", s.s32 < 0, s.u32 == -1);
  return 0;
}
