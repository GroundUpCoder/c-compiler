#include <stdio.h>
#include <string.h>

int main() {
  printf("%d\n", (int)strlen(""));
  printf("%d\n", (int)strlen("abc"));
  printf("%d\n", (int)strlen("hello world"));

  printf("%d\n", strcmp("abc", "abc") == 0);
  printf("%d\n", strcmp("abc", "abd") < 0);
  printf("%d\n", strcmp("abd", "abc") > 0);
  printf("%d\n", strcmp("", "") == 0);
  printf("%d\n", strcmp("a", "") > 0);

  printf("%d\n", strncmp("abcdef", "abcxyz", 3) == 0);
  printf("%d\n", strncmp("abcdef", "abcxyz", 4) != 0);

  return 0;
}
