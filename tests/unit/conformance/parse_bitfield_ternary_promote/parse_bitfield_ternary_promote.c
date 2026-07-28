// BUG: computeTernaryType received the branches' UNPROMOTED declared types,
// so `c ? bf : bf` on a narrow unsigned bit-field had type unsigned int and
// subsequent arithmetic went unsigned: (c ? u20 : u20) - 0x200000 < 0 was 0
// (todos/0367 residual of 0356 — the wide->declared rule was fixed for
// binary operands only).
// C11: 6.5.15p5 — the usual arithmetic conversions (which begin with the
// integer promotions, 6.3.1.8) are performed on arithmetic branch operands.
// EXPECT: a narrow bit-field branch promotes to signed int; a wider-than-int
// field keeps its declared type.
#include <stdio.h>

struct S {
  unsigned u20 : 20;
  int s10 : 10;
  unsigned long long ull20 : 20;
  unsigned long long ull40 : 40;
};

int main(void) {
  struct S t;

  t.u20 = 0xFFFFF;
  t.s10 = 1;
  printf("T1 %d\n", (t.s10 ? t.u20 : t.u20) - 0x200000 < 0);
  printf("T2 %llx\n", (unsigned long long)((t.s10 ? t.u20 : t.u20) - 0x200000));
  t.ull20 = 0;
  printf("T3 %d\n", (1 ? t.ull20 : t.ull20) - 1 < 0);
  /* control: a 40-bit field keeps unsigned long long */
  t.ull40 = 0;
  printf("T4 %d\n", (1 ? t.ull40 : t.ull40) - 1 < 0);
  /* mixed branch: UAC(int-promoted bf, unsigned) is unsigned — control */
  t.u20 = 1;
  printf("T5 %d\n", (1 ? t.u20 : 0u) - 5 < 0);
  return 0;
}
