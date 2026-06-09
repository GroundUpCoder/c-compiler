/* Regression: ftell on an update stream (r+) after a buffered read
 * applied BOTH the read-buffer subtraction and the write-buffer
 * addition (same buf_pos field), reporting position 2 after reading
 * one byte. Writes then landed at the wrong offset. */
#include <stdio.h>

int main(void) {
  const char *path = TEST_TMPDIR "ftell_update.txt";
  FILE *f = fopen(path, "w");
  if (!f) { puts("fopen w failed"); return 1; }
  fputs("0123456789", f);
  fclose(f);

  f = fopen(path, "r+");
  if (!f) { puts("fopen r+ failed"); return 1; }
  int c = fgetc(f);
  long pos = ftell(f);
  printf("c=%c pos=%ld\n", c, pos);

  fseek(f, pos, SEEK_SET);
  fputc('X', f);
  fclose(f);

  f = fopen(path, "r");
  char buf[32] = {0};
  fread(buf, 1, 31, f);
  fclose(f);
  printf("%s\n", buf);
  return 0;
}
