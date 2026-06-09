/* Regression: append mode must have O_APPEND semantics — every write
 * lands at current EOF regardless of seeks. The host snapshotted
 * position = size at open, so fseek(SET) + write overwrote the start
 * of the file. */
#include <stdio.h>
#include <string.h>

int main(void) {
  const char *path = TEST_TMPDIR "append_write_at_end.txt";
  FILE *f = fopen(path, "w");
  if (!f) { puts("fopen w failed"); return 1; }
  fputs("Hello world", f);
  fclose(f);

  f = fopen(path, "a");
  if (!f) { puts("fopen a failed"); return 1; }
  fseek(f, 0, SEEK_SET);
  fputs("END", f);
  fclose(f);

  f = fopen(path, "r");
  char buf[64] = {0};
  fread(buf, 1, 63, f);
  fclose(f);
  printf("%s\n", buf);

  /* a+ : reads honor the seek position, writes still go to EOF. */
  f = fopen(path, "a+");
  if (!f) { puts("fopen a+ failed"); return 1; }
  fseek(f, 0, SEEK_SET);
  int c = fgetc(f);
  fseek(f, 0, SEEK_CUR); /* required between read and write */
  fputc('!', f);
  fclose(f);

  f = fopen(path, "r");
  memset(buf, 0, sizeof buf);
  fread(buf, 1, 63, f);
  fclose(f);
  printf("%c %s\n", c, buf);
  return 0;
}
