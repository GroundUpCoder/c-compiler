/* Regression: character constants with high-bit escapes evaluated to
 * 128..255 even though char is signed on this target, so the common
 * pattern  char c = '\xff'; if (c == '\xff')  never matched. */
#include <stdio.h>

int main(void) {
  char c = '\xff';
  printf("%d %d %d\n", '\xff', '\200', '\x80');
  printf("%s\n", c == '\xff' ? "match" : "mismatch");
  printf("%d %d\n", 'A', '\x7f');
  return 0;
}
