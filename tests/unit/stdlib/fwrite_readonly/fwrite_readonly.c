#include <stdio.h>

int main() {
  FILE *f = fopen(TEST_TMPDIR "fwrite_ro.txt", "w");
  fclose(f);

  f = fopen(TEST_TMPDIR "fwrite_ro.txt", "r");
  size_t n = fwrite("x", 1, 1, f);  /* fails with the error flag set */
  printf("n=%zu ferror=%d\n", n, ferror(f) != 0);
  fclose(f);
  return 0;
}
