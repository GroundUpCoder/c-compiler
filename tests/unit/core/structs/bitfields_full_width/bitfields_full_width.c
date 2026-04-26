#include <stdio.h>

/* Bit-field that uses all 32 bits — should behave like a regular int */
struct Full {
  unsigned int val : 32;
};

/* Bit-field of width 31 — test near-full-width edge */
struct Almost {
  unsigned int val : 31;
};

/* Signed full-width */
struct FullSigned {
  int val : 32;
};

int main() {
  struct Full f;
  unsigned int *fr = (unsigned int *)&f;
  *fr = 0;

  f.val = 0xDEADBEEF;
  printf("full=0x%x\n", f.val);
  printf("full_raw=0x%x\n", *fr);

  /* 31-bit: max value is 0x7FFFFFFF */
  struct Almost a;
  unsigned int *ar = (unsigned int *)&a;
  *ar = 0;
  a.val = 0x7FFFFFFF;
  printf("almost_max=0x%x\n", a.val);
  /* Writing 0xFFFFFFFF should truncate to 31 bits */
  a.val = 0xFFFFFFFF;
  printf("almost_trunc=0x%x\n", a.val);

  /* Signed 32-bit: should behave like regular int */
  struct FullSigned fs;
  unsigned int *fsr = (unsigned int *)&fs;
  *fsr = 0;
  fs.val = -1;
  printf("full_signed=%d\n", fs.val);
  fs.val = -2147483647 - 1;  /* INT_MIN */
  printf("full_signed_min=%d\n", fs.val);

  return 0;
}
