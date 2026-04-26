#include <stdio.h>

/* Type-pun bit-field structs through unsigned int pointers to verify
   exact bit layout. Also pun through unsigned char to check byte order. */

struct Packed {
  unsigned int a : 3;  /* bits  0-2  */
  unsigned int b : 5;  /* bits  3-7  */
  unsigned int c : 7;  /* bits  8-14 */
  unsigned int d : 1;  /* bit  15    */
};

/* Two fields that exactly fill one int */
struct Full32 {
  unsigned int lo : 16;
  unsigned int hi : 16;
};

/* Struct with regular field followed by bit-fields */
struct MixedPun {
  unsigned int header;
  unsigned int x : 4;
  unsigned int y : 4;
};

int main() {
  /* --- Packed: verify individual bit positions --- */
  struct Packed p;
  unsigned int *raw = (unsigned int *)&p;
  *raw = 0;

  p.a = 5;   /* 101 */
  p.b = 17;  /* 10001 */
  p.c = 65;  /* 1000001 */
  p.d = 1;

  /* a occupies bits 0-2:   5        = 0x005
     b occupies bits 3-7:   17 << 3  = 0x088
     c occupies bits 8-14:  65 << 8  = 0x4100
     d occupies bit 15:     1 << 15  = 0x8000
     total = 0xC18D */
  printf("packed_raw=0x%x\n", *raw);

  /* Read back through the struct to make sure round-trip works */
  printf("a=%u b=%u c=%u d=%u\n", p.a, p.b, p.c, p.d);

  /* Clear one field, verify only its bits change */
  p.b = 0;
  printf("after_clear_b=0x%x\n", *raw);  /* 0xC105 */

  /* --- Full32: verify 16-bit halves --- */
  struct Full32 f;
  unsigned int *fraw = (unsigned int *)&f;
  *fraw = 0;
  f.lo = 0xABCD;
  f.hi = 0x1234;
  printf("full32=0x%x\n", *fraw);  /* 0x1234ABCD */

  /* Poke raw and read back */
  *fraw = 0xDEADBEEF;
  printf("lo=0x%x hi=0x%x\n", f.lo, f.hi);  /* lo=0xBEEF hi=0xDEAD */

  /* --- Byte-level type pun --- */
  struct Packed p2;
  unsigned int *r2 = (unsigned int *)&p2;
  *r2 = 0;
  p2.a = 7;  /* bits 0-2 all set */
  p2.b = 0;
  p2.c = 0;
  p2.d = 0;
  /* Only bits 0-2 are set = 0x07. First byte should be 0x07, rest 0x00. */
  unsigned char *bytes = (unsigned char *)&p2;
  printf("byte0=0x%02x byte1=0x%02x\n", bytes[0], bytes[1]);

  /* --- MixedPun: bit-fields after a regular field --- */
  struct MixedPun m;
  unsigned int *mraw = (unsigned int *)&m;
  mraw[0] = 0;  /* header */
  mraw[1] = 0;  /* bit-field storage unit */
  m.header = 0xAAAAAAAA;
  m.x = 0xF;
  m.y = 0x5;
  printf("mixed_hdr=0x%x mixed_bf=0x%x\n", mraw[0], mraw[1]);
  /* bf unit: x in bits 0-3 = 0xF, y in bits 4-7 = 0x50 => 0x5F */
  printf("x=%u y=%u\n", m.x, m.y);

  return 0;
}
