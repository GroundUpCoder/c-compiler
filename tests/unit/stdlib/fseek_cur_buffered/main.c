/* Regression: fseek(f, n, SEEK_CUR) must account for unconsumed
 * read-ahead in the FILE buffer. After one fgetc the underlying fd
 * sits at the end of the buffered read; a relative seek computed from
 * the raw fd position lands far past the logical position. */
#include <stdio.h>

int main(void) {
  const char *path = TEST_TMPDIR "fseek_cur_buffered.txt";
  FILE *f = fopen(path, "w");
  if (!f) { puts("fopen w failed"); return 1; }
  fputs("0123456789ABCDEF", f);
  fclose(f);

  f = fopen(path, "r");
  if (!f) { puts("fopen r failed"); return 1; }
  int c1 = fgetc(f);
  if (fseek(f, 0, SEEK_CUR) != 0) { puts("fseek failed"); return 1; }
  int c2 = fgetc(f);
  printf("%c %c %ld\n", c1, c2, ftell(f));

  if (fseek(f, 2, SEEK_CUR) != 0) { puts("fseek2 failed"); return 1; }
  int c3 = fgetc(f);
  printf("%c %ld\n", c3, ftell(f));
  fclose(f);
  return 0;
}
