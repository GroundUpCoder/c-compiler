// BUG: usualArithmeticConversions ranked by SIZE, not conversion rank
// (#643): same-signedness picked the FIRST operand on a width tie
// (int + long -> int, order-dependent), and mixed signedness returned
// the unsigned operand whenever its width >= the signed width, so
// long + unsigned int -> unsigned int where C requires unsigned long
// (the toU(signed) branch was unreachable). On this target the wrong
// answers share width and signedness with the right ones, so plain
// arithmetic values coincide — the observable defect is type identity:
// _Generic dispatch (and anything built on it) selects the wrong arm,
// which is a differing VALUE in a conforming program.
// C11: 6.3.1.8p1 (usual arithmetic conversions), 6.3.1.1p1 (rank order:
// int < long < long long regardless of width).
// EXPECT: ILP32-specific by design (int, long, unsigned long all 32-bit;
// the ilp32_long_literal_typing precedent): every cell verified with
// clang -target i686-pc-linux-gnu -fsyntax-only via a _Static_assert
// twin of this matrix (logs/2026-08-13/643-645-type-width-pair.md).
#include <stdio.h>

#define NAME(x) _Generic((x), \
  int: "int", unsigned int: "uint", \
  long: "long", unsigned long: "ulong", \
  long long: "llong", unsigned long long: "ullong", \
  default: "other")

int i; unsigned int ui; long l; unsigned long ul;
long long ll; unsigned long long ull;

#define ROW(a, b) printf("%-6s + %-6s -> %s\n", NAME(a), NAME(b), NAME((a) + (b)))

int main(void) {
  // Full matrix over {int, uint, long, ulong, llong, ullong}, both orders.
  ROW(i, ui);  ROW(ui, i);
  ROW(i, l);   ROW(l, i);
  ROW(i, ul);  ROW(ul, i);
  ROW(i, ll);  ROW(ll, i);
  ROW(i, ull); ROW(ull, i);
  ROW(ui, l);  ROW(l, ui);   // the #643 headline: unsigned long, not unsigned int
  ROW(ui, ul); ROW(ul, ui);
  ROW(ui, ll); ROW(ll, ui);
  ROW(ui, ull);ROW(ull, ui);
  ROW(l, ul);  ROW(ul, l);
  ROW(l, ll);  ROW(ll, l);
  ROW(l, ull); ROW(ull, l);
  ROW(ul, ll); ROW(ll, ul);
  ROW(ul, ull);ROW(ull, ul);
  ROW(ll, ull);ROW(ull, ll);

  // The other UAC consumers follow the same table: comparisons convert
  // at the common type (6.5.8p3) and ?: applies UAC to its arms.
  printf("cmp %d\n", -1L < 1U);                 // both -> unsigned long: 0
  printf("ternary %s\n", NAME(i ? l : ui));     // ulong
  // _Generic-dispatched VALUE difference (the observable miscompile shape):
  printf("dispatch %d\n", _Generic(l + ui, unsigned long: 1, unsigned int: 2, default: 3));
  return 0;
}
