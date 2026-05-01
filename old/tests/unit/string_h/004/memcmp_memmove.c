#include <stdio.h>
#include <string.h>

int main() {
  printf("%d\n", memcmp("abc", "abc", 3) == 0);
  printf("%d\n", memcmp("abc", "abd", 3) < 0);
  printf("%d\n", memcmp("abd", "abc", 3) > 0);
  printf("%d\n", memcmp("abc", "xyz", 0) == 0);

  // memmove with overlapping regions
  char buf[20];
  strcpy(buf, "hello world");
  memmove(buf + 2, buf, 5);
  buf[12] = 0;
  printf("%s\n", buf);

  return 0;
}
