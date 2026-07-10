// BUG: multi-character char constants ('SAME', 'GBS\x01') evaluated to the
//      FIRST character only (0x53, 0x47) instead of the GCC/clang big-endian
//      packing (0x53414D45, 0x47425301) — silently, with no diagnostic.
//      Found via SameBoy (0075): GBS/ISX/TPP1 magic detection miscompiled.
// C11: 6.4.4.4p10 — the value of a multi-character constant is
//      implementation-defined; we follow the GCC/clang packing (each char
//      shifted in from the right, int32 wrap, last 4 kept on overflow).
// EXPECT: packed values; single-char behavior (incl. '\xff' == -1 on this
//         signed-char target) unchanged; #if sees the same values.
#include <stdio.h>

#if 'AB' != 0x4142
#error "preprocessor multi-char packing disagrees with the compiler"
#endif

int main(void) {
  printf("%08x\n", (unsigned)'SAME');
  printf("%08x\n", (unsigned)'GBS\x01');
  printf("%08x\n", (unsigned)'AB');
  printf("%08x\n", (unsigned)'\1\2\3');
  printf("%d\n", 'A');
  printf("%d\n", '\xff');
  printf("%d\n", '\xff\xff\xff\xff');
  return 0;
}
