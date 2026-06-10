/* Regression: writing to a read-only stream (or reading a write-only
 * one) hit an explicit wasm trap and killed the process. C requires
 * EOF/0 with the stream's error indicator set. */
#include <stdio.h>

int main(void) {
  const char *path = TEST_TMPDIR "wrongdir.txt";
  FILE *f = fopen(path, "w");
  fputs("abc", f);
  fclose(f);

  f = fopen(path, "r");
  int r1 = fputc('X', f);
  size_t r2 = fwrite("x", 1, 1, f);
  printf("read-stream: %d %zu ferror=%d\n", r1, r2, ferror(f) != 0);
  clearerr(f);
  int c = fgetc(f);
  printf("still-readable: %c\n", c);
  fclose(f);

  f = fopen(path, "a");
  int r3 = fgetc(f);
  char buf[4];
  size_t r4 = fread(buf, 1, 1, f);
  printf("write-stream: %d %zu ferror=%d\n", r3, r4, ferror(f) != 0);
  fclose(f);

  /* file is intact */
  f = fopen(path, "r");
  char all[8] = {0};
  fread(all, 1, 7, f);
  fclose(f);
  printf("content: %s\n", all);
  return 0;
}
