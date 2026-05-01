#include <stdio.h>
#include <string.h>

int main() {
  char buf[32];
  memset(buf, 'A', 10);
  buf[10] = 0;
  printf("%s\n", buf);

  char src[] = "hello world";
  char dst[32];
  memcpy(dst, src, 12);
  printf("%s\n", dst);

  // memset with zero
  memset(buf, 0, 10);
  int all_zero = 1;
  for (int i = 0; i < 10; i++) {
    if (buf[i] != 0) all_zero = 0;
  }
  printf("all_zero=%d\n", all_zero);

  return 0;
}
