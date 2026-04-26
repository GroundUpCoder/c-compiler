#include <stdio.h>
#include <string.h>

int main() {
  // Null character escape
  char nul = '\0';
  printf("nul=%d\n", nul);  // should be 0, not 48

  // Octal escapes
  char oct_A = '\101';  // 65 = 'A'
  printf("oct_A=%c\n", oct_A);

  char oct_0 = '\000';
  printf("oct_0=%d\n", oct_0);  // should be 0

  // Hex escapes
  char hex_A = '\x41';
  printf("hex_A=%c\n", hex_A);

  // String with embedded null
  const char *s = "AB\0CD";
  printf("s_len=%d\n", (int)strlen(s));  // should be 2

  // Hex in string
  const char *hex = "\x48\x49";  // "HI"
  printf("hex=%s\n", hex);

  return 0;
}
