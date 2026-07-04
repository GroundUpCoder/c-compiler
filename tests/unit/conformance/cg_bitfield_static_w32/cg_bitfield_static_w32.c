// BUG: static initializer for a full-width (32-bit) unsigned bit-field stores 0 instead of the value
// C11: 6.7.9p9,p23 (bit-fields of structs are initialized per member, in declaration order); 6.7.2.1p10
// EXPECT: ga.x must read back 0xdeadbeef; a local const-initialized object must read back 0xcafebabe; matches native clang
#include <stdio.h>
struct A { unsigned x:32; };
static struct A ga = { 0xDEADBEEFu };
int main(void) {
  printf("ga.x=%x\n", ga.x);
  const struct A la = { 0xCAFEBABEu };
  printf("la.x=%x\n", la.x);
  return 0;
}
