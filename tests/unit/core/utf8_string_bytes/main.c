/* Regression: non-ASCII characters in string literals were truncated
 * to one byte per code point ("é" became 0xE9 instead of UTF-8
 * 0xC3 0xA9). Multibyte source characters, \u escapes, and u8
 * literals must all produce UTF-8 bytes. */
#include <stdio.h>

int main(void) {
  char a[] = "é";
  char b[] = "\u00e9";
  char c[] = u8"é";
  char d[] = "héllo";
  printf("%zu %02x %02x\n", sizeof a, (unsigned char)a[0], (unsigned char)a[1]);
  printf("%zu %02x %02x\n", sizeof b, (unsigned char)b[0], (unsigned char)b[1]);
  printf("%zu %02x %02x\n", sizeof c, (unsigned char)c[0], (unsigned char)c[1]);
  printf("%zu\n", sizeof d);
  printf("%s\n", "héllo wörld");
  printf("%d\n", "\xc3\xa9"[0] == (char)0xc3);
  return 0;
}
