/* Regression: sscanf round-tripped input through the UTF-8 decoder, so
 * non-UTF-8 bytes (0xE9) were replaced with U+FFFD (EF BF BD). */
#include <stdio.h>

int main(void) {
  char src[] = {'A', (char)0xE9, 'B', ' ', (char)0xFF, 'Z', 0};
  unsigned char dst[16] = {0};
  unsigned char dst2[16] = {0};
  int n = sscanf(src, "%s %s", (char *)dst, (char *)dst2);
  printf("n=%d\n", n);
  printf("%02x %02x %02x %02x\n", dst[0], dst[1], dst[2], dst[3]);
  printf("%02x %02x %02x\n", dst2[0], dst2[1], dst2[2]);

  char c;
  sscanf("\xc3", "%c", &c);
  printf("%02x\n", (unsigned char)c);
  return 0;
}
