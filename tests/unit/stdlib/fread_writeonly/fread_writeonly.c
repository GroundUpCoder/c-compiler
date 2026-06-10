#include <stdio.h>

int main() {
  FILE *f = fopen(TEST_TMPDIR "fread_wo.txt", "w");
  char buf[4];
  size_t n = fread(buf, 1, 1, f);  /* fails with the error flag set */
  printf("n=%zu ferror=%d\n", n, ferror(f) != 0);
  fclose(f);
  return 0;
}
