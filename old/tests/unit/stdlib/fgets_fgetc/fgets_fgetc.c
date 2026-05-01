#include <stdio.h>
#include <string.h>

int main() {
  const char *path = TEST_TMPDIR "fgets_fgetc.txt";

  /* Write lines */
  FILE *f = fopen(path, "w");
  if (!f) { printf("fopen write failed\n"); return 1; }
  fputs("line1\n", f);
  fputs("line2\n", f);
  fputs("abc", f);  /* no trailing newline */
  fclose(f);

  /* Read back with fgets */
  f = fopen(path, "r");
  if (!f) { printf("fopen read failed\n"); return 1; }
  char buf[64];
  char *r;
  r = fgets(buf, sizeof(buf), f);
  printf("fgets1: [%s] ret=%s\n", buf, r ? "ok" : "null");

  r = fgets(buf, sizeof(buf), f);
  printf("fgets2: [%s] ret=%s\n", buf, r ? "ok" : "null");

  r = fgets(buf, sizeof(buf), f);
  printf("fgets3: [%s] ret=%s\n", buf, r ? "ok" : "null");

  /* Should be EOF now */
  r = fgets(buf, sizeof(buf), f);
  printf("fgets4: ret=%s eof=%d\n", r ? "ok" : "null", feof(f));
  fclose(f);

  /* Read with fgetc */
  f = fopen(path, "r");
  if (!f) { printf("fopen read2 failed\n"); return 1; }
  int c;
  int count = 0;
  while ((c = fgetc(f)) != EOF) {
    count++;
  }
  printf("fgetc count: %d\n", count);
  printf("eof: %d\n", feof(f));
  fclose(f);

  return 0;
}
