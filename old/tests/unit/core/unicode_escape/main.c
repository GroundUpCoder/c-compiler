#include <stdio.h>
#include <string.h>

int main() {
  /* \u with non-ASCII BMP: e-acute (U+00E9) -> raw byte 0xE9 (fits in byte) */
  const char *cafe = "caf\u00E9";
  printf("cafe len=%d\n", (int)strlen(cafe));
  printf("cafe bytes:");
  for (int i = 0; i < (int)strlen(cafe); i++)
    printf(" %02x", (unsigned char)cafe[i]);
  printf("\n");

  /* \u with CJK character: U+4E16 -> UTF-8: 0xE4 0xB8 0x96 */
  const char *cjk = "\u4E16";
  printf("cjk len=%d\n", (int)strlen(cjk));
  printf("cjk bytes:");
  for (int i = 0; i < (int)strlen(cjk); i++)
    printf(" %02x", (unsigned char)cjk[i]);
  printf("\n");

  /* \U with 8 hex digits - supplementary character */
  /* U+1F600 (grinning face) -> UTF-8: 0xF0 0x9F 0x98 0x80 */
  const char *emoji = "\U0001F600";
  printf("emoji len=%d\n", (int)strlen(emoji));
  printf("emoji bytes:");
  for (int i = 0; i < (int)strlen(emoji); i++)
    printf(" %02x", (unsigned char)emoji[i]);
  printf("\n");

  /* Wide char literal with \u */
  int wch = L'\u00E9';
  printf("wch=%d\n", wch);  /* 233 */

  /* Mixed: regular + \u in one string */
  const char *mixed = "abc\u00F1xyz";
  printf("mixed bytes:");
  for (int i = 0; i < (int)strlen(mixed); i++)
    printf(" %02x", (unsigned char)mixed[i]);
  printf("\n");

  /* \u with 2-byte UTF-8 range (U+0100, Latin A with macron) -> 0xC4 0x80 */
  const char *latin = "\u0100";
  printf("latin bytes:");
  for (int i = 0; i < (int)strlen(latin); i++)
    printf(" %02x", (unsigned char)latin[i]);
  printf("\n");

  return 0;
}
