// BUG: the #if evaluator had its own integer-constant decoder that had
//      drifted from the lexer's — it never learned 0b/0B binary literals,
//      so `#if 0b1` was a lex error while `int x = 0b1;` compiled fine
//      (duplication-with-drift; both now funnel through one decoder).
// C11: 6.10.1p4 / 6.4.4.1 — binary literals are a C23/GNU extension this
//      compiler supports in normal code, so #if must accept them too
//      (clang/gcc both do). Arithmetic stays at intmax_t width (0218).
// EXPECT: every #if below selects the true branch; the printf parity line
//         proves #if and normal code decode the same values.
#include <stdio.h>

int main(void) {
#if 0b1
  puts("A:true");
#else
  puts("A:false");
#endif
#if 0b1010 == 10 && 0B11 == 3
  puts("B:val");
#else
  puts("B:bad");
#endif
#if 0b101u == 5 && 0b110UL == 6 && 0b111ull == 7
  puts("C:suffix");
#else
  puts("C:bad");
#endif
#if 0b1111111111111111111111111111111111111111111111111111111111111111u == 0xFFFFFFFFFFFFFFFFu
  puts("D:intmax");
#else
  puts("D:bad");
#endif
#if (0b1 << 4) == 0b10000 && -0b10 < 0
  puts("E:arith");
#else
  puts("E:bad");
#endif
  printf("F:%d %d %u\n", 0b1010, 0B11, 0b101u);
  return 0;
}
