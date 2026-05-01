#include <stdio.h>
#include <string.h>

int main() {
  const char *s = "hello world";

  char *p = strchr(s, 'o');
  printf("%s\n", p);

  p = strrchr(s, 'o');
  printf("%s\n", p);

  printf("%d\n", strchr(s, 'z') == 0);
  printf("%d\n", strchr(s, 0) != 0);

  p = strstr(s, "world");
  printf("%s\n", p);

  p = strstr(s, "xyz");
  printf("%d\n", p == 0);

  p = strstr(s, "");
  printf("%s\n", p);

  return 0;
}
