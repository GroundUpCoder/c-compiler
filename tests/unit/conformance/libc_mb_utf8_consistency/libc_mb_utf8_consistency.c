// BUG: mbtowc/wctomb use Latin-1 byte passthrough while mbrtowc/wcrtomb use UTF-8 — the two families disagree on the multibyte encoding.
// C11: 7.22.7 / 7.29.6.3 — the non-restartable and restartable conversion functions describe the same execution-environment multibyte encoding; one program must see one consistent encoding.
// EXPECT: UTF-8 for both families (this libc's restartable family is documented UTF-8): "\xC3\xA9" -> n=2, wc=233 (U+00E9) and wc 233 -> 2 bytes 195 169. Native macOS clang in the "C" locale is byte-passthrough, so this expectation follows the libc's own UTF-8 restartable family rather than the (legitimately different) native output.
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

int main(void) {
  const char *u8 = "\xC3\xA9"; /* e-acute, UTF-8 */
  wchar_t wc = 0;
  int n = mbtowc(&wc, u8, 2);
  printf("mbtowc n=%d wc=%d\n", n, (int)wc);

  mbstate_t st = {0};
  wchar_t wc2 = 0;
  size_t m = mbrtowc(&wc2, u8, 2, &st);
  printf("mbrtowc n=%d wc=%d\n", (int)m, (int)wc2);

  char b1[8] = {0};
  int k = wctomb(b1, 233);
  printf("wctomb k=%d b0=%d b1=%d\n", k, (unsigned char)b1[0],
         k > 1 ? (unsigned char)b1[1] : -1);

  char b2[8] = {0};
  mbstate_t st2 = {0};
  size_t k2 = wcrtomb(b2, 233, &st2);
  printf("wcrtomb k=%d b0=%d b1=%d\n", (int)k2, (unsigned char)b2[0],
         (int)k2 > 1 ? (unsigned char)b2[1] : -1);
  return 0;
}
