// BUG: constEvalExpr (the static-initializer evaluator) bounded shift
// counts by a hardcoded 64 instead of the promoted left operand's width
// (#645), so a 32-bit shift with a count in 32..63 folded to a value the
// runtime shift disagrees with: `int g = 1 << 32;` folded to 0 while the
// compiled shift masks the count (wasm semantics) and gives 1. The same
// expression gave one answer when the operands were compile-time
// constants and another when they were not — a fold-dependent silent
// miscompile. Now the fold declines at the promoted width, exactly like
// ConstEval.binary (and like count >= 64 always did), so runtime
// semantics stand; static initializers with UB counts are diagnosed
// (diag_shift_fold_count_ub).
// C11: 6.5.7p3 — the shift result has the promoted left operand's type,
// and a count >= that type's width is undefined; 6.5.7p4-p5.
// EXPECT: the "static" rows are C11-defined values (clang-verified; count
// and value chosen identical under ILP32 and LP64). The AGREE rows pin
// fold-vs-runtime consistency: each computes one shift with constant
// operands and again with volatile-laundered operands and prints whether
// they agree — for the UB-count rows no VALUE is pinned (UB; clang cannot
// verify those rows), only that the two paths cannot diverge.
#include <stdio.h>

// Static initializers: the fold is mandatory here (no runtime path).
// Promoted-width proof: (signed char)1 << 8 folds at int width -> 256,
// not at width 8 -> 0. All rows are defined behavior.
int sc8 = (signed char)1 << 8;
int uc1 = (unsigned char)0x80 << 1;
int sh3 = (short)0x1000 << 3;
int i30 = 1 << 30;
unsigned u31 = 1u << 31;
long l20 = 1L << 20;
unsigned long ul31 = 1ul << 31;
long long ll40 = 1ll << 40;
unsigned long long ull63 = 1ull << 63;
int sr = -256 >> 4;                 // impl-defined: arithmetic shift, matches clang
unsigned usr = 0x80000000u >> 31;

#define ROW(label, T, lc, cc, SHOP) do { \
  T cst = (T)((T)(lc) SHOP (cc)); \
  volatile T vl = (T)(lc); volatile int vc = (cc); \
  T rt = (T)(vl SHOP vc); \
  printf("%-24s %s\n", label, (cst == rt) ? "AGREE" : "DIVERGE"); \
} while (0)

int main(void) {
  printf("sc8=%d uc1=%d sh3=%d i30=%d u31=%u\n", sc8, uc1, sh3, i30, u31);
  printf("l20=%ld ul31=%lu ll40=%lld ull63=%llu\n", l20, ul31, ll40, ull63);
  printf("sr=%d usr=%u\n", sr, usr);

  // Valid counts: fold and runtime must agree everywhere.
  ROW("char 1<<3", signed char, 1, 3, <<);
  ROW("short 1<<9", short, 1, 9, <<);
  ROW("int 1<<30", int, 1, 30, <<);
  ROW("uint 1<<31", unsigned int, 1, 31, <<);
  ROW("long 1<<20", long, 1, 20, <<);
  ROW("llong 1<<40", long long, 1, 40, <<);
  ROW("ullong 1<<63", unsigned long long, 1, 63, <<);
  ROW("int -256>>4", int, -256, 4, >>);
  // UB counts (>= promoted width): whatever the target does, the folded
  // and runtime answers must be the SAME answer.
  ROW("char 1<<32 (prom int)", signed char, 1, 32, <<);
  ROW("char 1<<40 (prom int)", signed char, 1, 40, <<);
  ROW("short 1<<33 (prom int)", short, 1, 33, <<);
  ROW("int 1<<32", int, 1, 32, <<);
  ROW("int 1<<33", int, 1, 33, <<);
  ROW("uint 1<<32", unsigned int, 1, 32, <<);
  ROW("long 1<<32", long, 1, 32, <<);
  ROW("ulong 1<<40", unsigned long, 1, 40, <<);
  ROW("int -8>>32", int, -8, 32, >>);
  ROW("uint hi>>32", unsigned int, 0x80000000u, 32, >>);
  ROW("llong 1<<64", long long, 1, 64, <<);
  ROW("ullong 1<<65", unsigned long long, 1, 65, <<);
  return 0;
}
