#include <stdio.h>

/* Signed bit-fields: test sign extension and min/max values */
struct S1 {
  int a : 1;   /* range: -1 to 0 */
  int b : 2;   /* range: -2 to 1 */
  int c : 8;   /* range: -128 to 127 */
  int d : 16;  /* range: -32768 to 32767 */
};

/* Mixed signed and unsigned: different base types go to separate units */
struct Mixed {
  int      s : 4;    /* signed, in unit 0 */
  unsigned u : 4;    /* unsigned, in unit 1 (different type) */
};

/* Sign extension edge: store -1 in various widths */
struct AllNeg1 {
  int a : 1;
  int b : 3;
  int c : 7;
  int d : 15;
};

int main() {
  struct S1 s;
  unsigned int *raw = (unsigned int *)&s;
  *raw = 0;

  /* 1-bit signed: 0 and -1 are the only values */
  s.a = 0;
  printf("a_zero=%d\n", s.a);  /* 0 */
  s.a = -1;
  printf("a_neg1=%d\n", s.a);  /* -1 */
  /* Storing 1 in a 1-bit signed field: bit pattern 1 = -1 */
  s.a = 1;
  printf("a_one=%d\n", s.a);   /* -1 (wraps) */

  /* 2-bit signed: range -2..1 */
  s.b = 1;
  printf("b_1=%d\n", s.b);
  s.b = -2;
  printf("b_neg2=%d\n", s.b);
  s.b = -1;
  printf("b_neg1=%d\n", s.b);
  /* Overflow: 2 doesn't fit in 2-bit signed (max is 1) */
  s.b = 2;
  printf("b_2_wrap=%d\n", s.b);  /* -2 (wraps) */

  /* 8-bit range */
  s.c = 127;
  printf("c_max=%d\n", s.c);
  s.c = -128;
  printf("c_min=%d\n", s.c);

  /* 16-bit range */
  s.d = 32767;
  printf("d_max=%d\n", s.d);
  s.d = -32768;
  printf("d_min=%d\n", s.d);

  /* Mixed signed/unsigned: separate storage units (int vs unsigned) */
  struct Mixed m;
  unsigned int *mraw = (unsigned int *)&m;
  mraw[0] = 0; mraw[1] = 0;
  m.s = -1;
  m.u = 15;
  printf("mixed_s=%d mixed_u=%u\n", m.s, m.u);
  printf("sizeof_Mixed=%d\n", (int)sizeof(struct Mixed));
  /* s is in unit0, u is in unit1 */
  printf("mixed_raw0=0x%x mixed_raw1=0x%x\n", mraw[0], mraw[1]);

  /* Read signed field values */
  mraw[0] = 0; mraw[1] = 0;
  m.s = 7;   /* max positive for 4-bit signed */
  printf("mixed_s_7=%d\n", m.s);
  m.s = -8;  /* min negative for 4-bit signed */
  printf("mixed_s_neg8=%d\n", m.s);

  /* All fields set to -1 */
  struct AllNeg1 an;
  unsigned int *anr = (unsigned int *)&an;
  *anr = 0;
  an.a = -1;
  an.b = -1;
  an.c = -1;
  an.d = -1;
  printf("allneg_a=%d b=%d c=%d d=%d\n", an.a, an.b, an.c, an.d);
  /* Verify raw: all the used bits should be 1 */
  /* a:1 + b:3 + c:7 + d:15 = 26 bits, all 1 => 0x3FFFFFF */
  printf("allneg_raw=0x%x\n", *anr);

  /* Comparison: signed bit-field vs integer */
  struct S1 cmp;
  unsigned int *cmpr = (unsigned int *)&cmp;
  *cmpr = 0;
  cmp.c = -5;
  int val = cmp.c;
  printf("cmp_val=%d\n", val);
  printf("cmp_lt0=%d\n", cmp.c < 0);

  return 0;
}
