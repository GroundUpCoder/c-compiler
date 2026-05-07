/* Hex literals above INT_MAX (0x80000000..0xffffffff) have type
 * unsigned int in C, not int.  Arithmetic on them must use unsigned
 * semantics throughout — even when a sub-expression involves a shift
 * that yields a narrower packed intermediate.
 *
 * The CRC-32 polynomial 0xedb88320 is a canonical example of such a
 * constant: it fits in unsigned int but not signed int.
 */
#include <stdio.h>

#define POLY 0xedb88320u

static unsigned crc_step(unsigned reg) {
  return reg & 1 ? (reg >> 1) ^ POLY : reg >> 1;
}

int main(void) {
  /* Direct XOR with an over-INT_MAX hex literal. */
  unsigned a = 0;
  printf("%u\n", a ^ 0xedb88320u);         /* 3988292384 */

  /* XOR after a shift — the intermediate (reg>>1) must widen to u32
   * before being XOR'd with the unsigned constant. */
  unsigned b = 2;
  printf("%u\n", (b >> 1) ^ 0xedb88320u);  /* 3988292385 */

  /* Same pattern exercised through a function to defeat constant folding. */
  printf("%u\n", crc_step(0));  /* 0&1=0 → 0>>1 = 0 */
  printf("%u\n", crc_step(1));  /* 1&1=1 → (1>>1)^POLY = 0^POLY = 3988292384 */
  printf("%u\n", crc_step(2));  /* 2&1=0 → 2>>1 = 1 */

  /* Hex constant in an assignment target typed as unsigned long. */
  unsigned long c = 5;
  c = (c >> 1) ^ 0xedb88320u;
  printf("%lu\n", c);                       /* 2 ^ 0xedb88320 = 3988292386 */

  return 0;
}
