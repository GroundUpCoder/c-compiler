#include <stdio.h>
#include <wchar.h>

int main() {
  wchar_t wc;
  size_t r;

  /* ASCII */
  r = mbrtowc(&wc, "A", 1, NULL);
  printf("ascii len=%lu wc=%d\n", (unsigned long)r, (int)wc);

  /* NUL */
  r = mbrtowc(&wc, "", 1, NULL);
  printf("nul len=%lu\n", (unsigned long)r);

  /* 2-byte UTF-8: U+00E9 (e-acute) = C3 A9 */
  r = mbrtowc(&wc, "\xC3\xA9", 2, NULL);
  printf("2byte len=%lu wc=%d\n", (unsigned long)r, (int)wc);

  /* 3-byte UTF-8: U+4E16 (CJK) = E4 B8 96 */
  r = mbrtowc(&wc, "\xE4\xB8\x96", 3, NULL);
  printf("3byte len=%lu wc=%d\n", (unsigned long)r, (int)wc);

  /* 4-byte UTF-8: U+1F600 (emoji) = F0 9F 98 80 */
  r = mbrtowc(&wc, "\xF0\x9F\x98\x80", 4, NULL);
  printf("4byte len=%lu wc=%d\n", (unsigned long)r, (int)wc);

  /* Incomplete sequence */
  r = mbrtowc(&wc, "\xC3", 1, NULL);
  printf("incomplete=%lu\n", (unsigned long)r);

  /* wcrtomb: ASCII */
  char mb[8];
  r = wcrtomb(mb, 'B', NULL);
  printf("wc2mb ascii len=%lu byte=%d\n", (unsigned long)r, (int)(unsigned char)mb[0]);

  /* wcrtomb: U+00E9 */
  r = wcrtomb(mb, 0xE9, NULL);
  printf("wc2mb 2byte len=%lu b0=%d b1=%d\n", (unsigned long)r, (int)(unsigned char)mb[0], (int)(unsigned char)mb[1]);

  /* wcrtomb: U+4E16 */
  r = wcrtomb(mb, 0x4E16, NULL);
  printf("wc2mb 3byte len=%lu b0=%d b1=%d b2=%d\n", (unsigned long)r,
    (int)(unsigned char)mb[0], (int)(unsigned char)mb[1], (int)(unsigned char)mb[2]);

  /* wcrtomb: U+1F600 */
  r = wcrtomb(mb, 0x1F600, NULL);
  printf("wc2mb 4byte len=%lu b0=%d b1=%d b2=%d b3=%d\n", (unsigned long)r,
    (int)(unsigned char)mb[0], (int)(unsigned char)mb[1],
    (int)(unsigned char)mb[2], (int)(unsigned char)mb[3]);

  /* wcrtomb: NULL dest returns 1 */
  r = wcrtomb(NULL, 'X', NULL);
  printf("wc2mb null=%lu\n", (unsigned long)r);

  return 0;
}
