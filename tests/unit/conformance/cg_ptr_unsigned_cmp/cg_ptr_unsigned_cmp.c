// BUG: relational comparison of pointers uses SIGNED 32-bit compares, so addresses above 2 GiB order below low addresses
// C11: 6.5.8p5 (pointers into the same object compare by address order); wasm32 linear-memory addresses are unsigned, so same-object ordering once memory exceeds 2 GiB requires unsigned compares
// EXPECT: 0x90000000 > 0x10000000 under unsigned address ordering -> 1 0 1 0; matches native clang on the same program
#include <stdio.h>
int main(void) {
  char *hi = (char*)0x90000000u;
  char *lo = (char*)0x10000000u;
  printf("hi>lo=%d hi<lo=%d hi>=lo=%d hi<=lo=%d\n",
         hi > lo, hi < lo, hi >= lo, hi <= lo);
  return 0;
}
