/* Regression: fread with size==0 trapped with a wasm divide-by-zero;
 * fwrite with size==0 returned nmemb. C requires both to return 0 and
 * leave the stream untouched. */
#include <stdio.h>

int main(void) {
  const char *path = TEST_TMPDIR "fread_zero.txt";
  FILE *f = fopen(path, "w");
  if (!f) { puts("fopen w failed"); return 1; }
  size_t w = fwrite("xyz", 0, 3, f);
  fputs("abc", f);
  fclose(f);

  f = fopen(path, "r");
  if (!f) { puts("fopen r failed"); return 1; }
  char buf[8];
  size_t r1 = fread(buf, 0, 3, f);
  size_t r2 = fread(buf, 3, 0, f);
  printf("w=%zu r1=%zu r2=%zu\n", w, r1, r2);

  size_t r3 = fread(buf, 1, 3, f);
  buf[r3] = 0;
  printf("r3=%zu %s\n", r3, buf);
  fclose(f);
  return 0;
}
