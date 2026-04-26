#include <stdio.h>

/* 32 single-bit flags packed into one int */
struct Flags32 {
  unsigned int b0  : 1; unsigned int b1  : 1; unsigned int b2  : 1; unsigned int b3  : 1;
  unsigned int b4  : 1; unsigned int b5  : 1; unsigned int b6  : 1; unsigned int b7  : 1;
  unsigned int b8  : 1; unsigned int b9  : 1; unsigned int b10 : 1; unsigned int b11 : 1;
  unsigned int b12 : 1; unsigned int b13 : 1; unsigned int b14 : 1; unsigned int b15 : 1;
  unsigned int b16 : 1; unsigned int b17 : 1; unsigned int b18 : 1; unsigned int b19 : 1;
  unsigned int b20 : 1; unsigned int b21 : 1; unsigned int b22 : 1; unsigned int b23 : 1;
  unsigned int b24 : 1; unsigned int b25 : 1; unsigned int b26 : 1; unsigned int b27 : 1;
  unsigned int b28 : 1; unsigned int b29 : 1; unsigned int b30 : 1; unsigned int b31 : 1;
};

int main() {
  printf("sizeof_Flags32=%d\n", (int)sizeof(struct Flags32));  /* 4 */

  struct Flags32 f;
  unsigned int *raw = (unsigned int *)&f;
  *raw = 0;

  /* Set every other bit */
  f.b0 = 1; f.b2 = 1; f.b4 = 1; f.b6 = 1;
  f.b8 = 1; f.b10 = 1; f.b12 = 1; f.b14 = 1;
  f.b16 = 1; f.b18 = 1; f.b20 = 1; f.b22 = 1;
  f.b24 = 1; f.b26 = 1; f.b28 = 1; f.b30 = 1;
  /* Pattern: 01010101... = 0x55555555 */
  printf("alternating=0x%x\n", *raw);

  /* Now set the other bits too => all 1s */
  f.b1 = 1; f.b3 = 1; f.b5 = 1; f.b7 = 1;
  f.b9 = 1; f.b11 = 1; f.b13 = 1; f.b15 = 1;
  f.b17 = 1; f.b19 = 1; f.b21 = 1; f.b23 = 1;
  f.b25 = 1; f.b27 = 1; f.b29 = 1; f.b31 = 1;
  printf("all_ones=0x%x\n", *raw);

  /* Clear bit 0, check only bit 0 changed */
  f.b0 = 0;
  printf("clear_b0=0x%x\n", *raw);  /* 0xFFFFFFFE */

  /* Clear bit 31 */
  f.b31 = 0;
  printf("clear_b31=0x%x\n", *raw); /* 0x7FFFFFFE */

  /* Read individual bits from raw pattern */
  *raw = 0xA5A5A5A5;
  printf("b0=%u b1=%u b2=%u b7=%u b8=%u b31=%u\n",
       f.b0, f.b1, f.b2, f.b7, f.b8, f.b31);
  /* 0xA5 = 10100101, so b0=1,b1=0,b2=1,b7=1,b8=0 ...
     bit 31: 0xA5A5A5A5 >> 31 = 1 */

  return 0;
}
