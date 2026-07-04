// BUG: static initializer for bit-fields in a 64-bit (unsigned long long) storage unit is corrupted
// C11: 6.7.9p9,p23 (struct members incl. bit-fields initialized in declaration order); 6.7.2.1p10
// EXPECT: gb.x reads back 0x123456789a and gb.y 0xabcdef; matches native clang
#include <stdio.h>
struct B { unsigned long long x:40, y:24; };
static struct B gb = { 0x123456789Aull, 0xABCDEF };
int main(void) {
  printf("x=%llx y=%llx\n", (unsigned long long)gb.x, (unsigned long long)gb.y);
  return 0;
}
