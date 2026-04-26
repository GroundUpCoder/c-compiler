#include <stdio.h>

struct S {
  unsigned int a : 4;  /* 0-15 */
  unsigned int b : 4;  /* 0-15 */
};

int main() {
  struct S s;
  unsigned int *raw = (unsigned int *)&s;
  *raw = 0;

  /* Compound assignment operators */
  s.a = 10;
  s.a -= 3;
  printf("sub_assign=%u\n", s.a);  /* 7 */

  s.a = 5;
  s.a *= 2;
  printf("mul_assign=%u\n", s.a);  /* 10 */

  s.a = 15;
  s.a &= 6;
  printf("and_assign=%u\n", s.a);  /* 6 */

  s.a = 9;
  s.a ^= 6;
  printf("xor_assign=%u\n", s.a);  /* 15 */

  s.a = 8;
  s.a >>= 2;
  printf("shr_assign=%u\n", s.a);  /* 2 */

  s.a = 3;
  s.a <<= 2;
  printf("shl_assign=%u\n", s.a);  /* 12 */

  /* Verify b wasn't corrupted by operations on a */
  s.b = 13;
  s.a = 0;
  s.a += 5;
  printf("a=%u b_intact=%u\n", s.a, s.b);  /* a=5, b=13 */

  /* Compound assignment on both fields interleaved */
  s.a = 1;
  s.b = 1;
  s.a += 2;
  s.b += 4;
  s.a += 3;
  s.b += 2;
  printf("interleaved a=%u b=%u\n", s.a, s.b);  /* a=6, b=7 */

  /* Compound assignment via arrow */
  struct S *p = &s;
  p->a = 10;
  p->a -= 1;
  printf("arrow_compound=%u\n", p->a);  /* 9 */

  /* Use bit-field in expression (implicit promotion to int) */
  s.a = 7;
  s.b = 3;
  int result = s.a + s.b;
  printf("expr_result=%d\n", result);  /* 10 */

  /* Bit-field as condition */
  s.a = 0;
  s.b = 1;
  printf("cond_a=%d cond_b=%d\n", s.a ? 1 : 0, s.b ? 1 : 0);

  /* Assignment expression returns the value */
  s.a = 0;
  int v = (s.a = 12);
  printf("assign_ret=%d field=%u\n", v, s.a);

  /* Compound assignment return value */
  s.a = 5;
  v = (s.a += 3);
  printf("compound_ret=%d field=%u\n", v, s.a);

  return 0;
}
