// BUG: converting a pointer value to unsigned long long sign-extends the 32-bit address instead of zero-extending
// C11: 6.3.2.3p6 (pointer-to-integer is implementation-defined but must reflect the address value); wasm32 addresses are unsigned 32-bit, so widening must zero-extend
// EXPECT: (unsigned long long)p for p == (char*)0x90000000 is 0x90000000, not 0xffffffff90000000; matches native clang
#include <stdio.h>
int main(void) {
  char *p = (char*)0x90000000u;
  unsigned long long w = (unsigned long long)p;
  printf("%llx\n", w);
  return 0;
}
