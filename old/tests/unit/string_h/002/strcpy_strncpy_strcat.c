#include <stdio.h>
#include <string.h>

int main() {
  char buf[64];

  strcpy(buf, "hello");
  printf("%s\n", buf);

  strcat(buf, " world");
  printf("%s\n", buf);

  char dst[10];
  strncpy(dst, "hi", 10);
  printf("%s\n", dst);
  // Verify padding with zeros
  int padded = 1;
  for (int i = 3; i < 10; i++) {
    if (dst[i] != 0) padded = 0;
  }
  printf("padded=%d\n", padded);

  return 0;
}
