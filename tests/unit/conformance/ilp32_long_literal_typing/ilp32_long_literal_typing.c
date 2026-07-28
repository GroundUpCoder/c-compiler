// BUG: none (guard) — pins ILP32 integer-constant typing, the semantics axis behind todos/0404: csmith seed 450020699 "ran away" because the LP64 clang oracle types 0xD7D41305L as signed 64-bit long while wasm32 types it unsigned 32-bit, so the two toolchains ran two different programs (ours was correct; the seed legitimately never terminates under ILP32)
// C11: 6.4.4.1p5 — a hex constant with suffix L takes the first fitting type of {long, unsigned long, long long, unsigned long long}; long is 32 bits on wasm32, so values in (INT32_MAX, UINT32_MAX] become UNSIGNED long and comparisons against them convert the other operand to unsigned
// EXPECT: ILP32-specific by design (NOT LP64-clean like the rest of the corpus): lines A/B/E differ from LP64 clang; verified against clang -target i686-pc-linux-gnu constant folding, transcript in todos/0404
#include <stdio.h>
int main(void) {
  int g = 0;
  printf("A %d\n", (~g) >= 0xD7D41305L);       /* seed 450020699's func_18 argument: unsigned compare -> 1 (LP64: 0) */
  printf("B %d\n", (int)sizeof(0xD7D41305L));  /* unsigned long, 32-bit -> 4 (LP64: 8) */
  printf("C %d\n", 0xD7D41305L < 0);           /* unsigned -> 0 */
  printf("D %d\n", (int)sizeof(0x1D7D41305L)); /* exceeds 32 bits -> long long -> 8 */
  printf("E %d\n", (int)sizeof(4294967286UL)); /* UL fits unsigned long(32) -> 4 (LP64: 8) */
  printf("F %d\n", (int)sizeof(3000000000));   /* unsuffixed decimal never goes unsigned -> long long -> 8 */
  printf("G %d\n", (int)sizeof(0xB2D05E00));   /* unsuffixed hex fits unsigned int -> 4 */
  printf("H %d\n", 3000000000 > -1);           /* signed 64-bit compare -> 1 */
  printf("J %d\n", (int)sizeof(2147483648));   /* decimal INT32_MAX+1 -> long long -> 8 */
  return 0;
}
