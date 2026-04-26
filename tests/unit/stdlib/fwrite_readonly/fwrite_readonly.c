#include <stdio.h>

int main() {
  FILE *f = fopen(TEST_TMPDIR "fwrite_ro.txt", "w");
  fclose(f);

  f = fopen(TEST_TMPDIR "fwrite_ro.txt", "r");
  fwrite("x", 1, 1, f);  /* should crash: stream is not writable */
  fclose(f);
  return 0;
}
