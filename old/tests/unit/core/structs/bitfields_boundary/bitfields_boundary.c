#include <stdio.h>

/* Test fields that sit right at the 32-bit boundary */
struct AtBoundary {
  unsigned int a : 31;
  unsigned int b : 1;   /* bit 31 — the very last bit of the int */
};

/* Field that won't fit: 31 + 2 = 33, so b goes to next unit */
struct Overflow {
  unsigned int a : 31;
  unsigned int b : 2;
};

/* Zero-width between same-type fields */
struct ZeroSplit {
  unsigned int a : 8;
  unsigned int : 0;
  unsigned int b : 8;
};

/* Bit-field after zero-width at start */
struct ZeroFirst {
  unsigned int : 0;
  unsigned int a : 4;
};

/* Multiple anonymous padding fields eating bits */
struct MultiAnon {
  unsigned int a : 2;
  unsigned int : 3;
  unsigned int : 3;
  unsigned int b : 2;
};

/* Verify that writing one field in a packed pair doesn't corrupt the other */
struct Pair {
  unsigned int lo : 16;
  unsigned int hi : 16;
};

int main() {
  /* AtBoundary: both fit in one int */
  printf("sizeof_AtBoundary=%d\n", (int)sizeof(struct AtBoundary));
  struct AtBoundary ab;
  unsigned int *abr = (unsigned int *)&ab;
  *abr = 0;
  ab.a = 0x7FFFFFFF;  /* all 31 bits */
  ab.b = 1;           /* bit 31 */
  printf("ab_raw=0x%x\n", *abr);  /* 0xFFFFFFFF */
  printf("ab_a=0x%x ab_b=%u\n", ab.a, ab.b);

  /* Overflow: two units */
  printf("sizeof_Overflow=%d\n", (int)sizeof(struct Overflow));
  struct Overflow ov;
  unsigned int *ovr = (unsigned int *)&ov;
  ovr[0] = 0; ovr[1] = 0;
  ov.a = 0x55555555;  /* truncated to 31 bits = 0x55555555 & 0x7FFFFFFF = 0x55555555 */
  ov.b = 3;
  printf("ov_unit0=0x%x ov_unit1=0x%x\n", ovr[0], ovr[1]);
  printf("ov_a=0x%x ov_b=%u\n", ov.a, ov.b);

  /* ZeroSplit */
  printf("sizeof_ZeroSplit=%d\n", (int)sizeof(struct ZeroSplit));
  struct ZeroSplit zs;
  unsigned int *zsr = (unsigned int *)&zs;
  zsr[0] = 0; zsr[1] = 0;
  zs.a = 0xAB;
  zs.b = 0xCD;
  /* a in unit0 bits 0-7, b in unit1 bits 0-7 */
  printf("zs_unit0=0x%x zs_unit1=0x%x\n", zsr[0], zsr[1]);

  /* ZeroFirst: zero-width at start should be a no-op */
  printf("sizeof_ZeroFirst=%d\n", (int)sizeof(struct ZeroFirst));
  struct ZeroFirst zf;
  unsigned int *zfr = (unsigned int *)&zf;
  *zfr = 0;
  zf.a = 9;
  printf("zf_raw=0x%x\n", *zfr);

  /* MultiAnon: a(2) + anon(3) + anon(3) + b(2) = 10 bits, one int */
  printf("sizeof_MultiAnon=%d\n", (int)sizeof(struct MultiAnon));
  struct MultiAnon ma;
  unsigned int *mar = (unsigned int *)&ma;
  *mar = 0;
  ma.a = 3;
  ma.b = 2;
  /* a at bits 0-1 = 3, b at bits 8-9 = 2<<8 = 0x200 => raw = 0x203 */
  printf("ma_raw=0x%x\n", *mar);
  printf("ma_a=%u ma_b=%u\n", ma.a, ma.b);

  /* Pair: verify no corruption between fields */
  struct Pair p;
  unsigned int *pr = (unsigned int *)&p;
  *pr = 0xDEADBEEF;
  p.lo = 0x1234;
  printf("pair_after_lo=0x%x\n", *pr);  /* hi unchanged: 0xDEAD1234 */
  p.hi = 0x5678;
  printf("pair_after_hi=0x%x\n", *pr);  /* 0x56781234 */
  printf("pair_lo=0x%x pair_hi=0x%x\n", p.lo, p.hi);

  /* Repeated writes: ensure read-modify-write is idempotent */
  *pr = 0;
  int i;
  for (i = 0; i < 100; i++) {
    p.lo = (unsigned int)(i & 0xFFFF);
    p.hi = (unsigned int)((i * 7) & 0xFFFF);
  }
  printf("final_lo=%u final_hi=%u\n", p.lo, p.hi);
  /* i=99: lo = 99, hi = 693 & 0xFFFF = 693 */

  return 0;
}
