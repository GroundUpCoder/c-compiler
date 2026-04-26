#include <stdio.h>
#include <string.h>

int main() {
  const char *path = TEST_TMPDIR "append_mode.txt";

  /* First write */
  FILE *f = fopen(path, "w");
  if (!f) { printf("fopen w failed\n"); return 1; }
  fputs("AAA", f);
  fclose(f);

  /* Append */
  f = fopen(path, "a");
  if (!f) { printf("fopen a failed\n"); return 1; }
  fputs("BBB", f);
  fclose(f);

  /* Append more */
  f = fopen(path, "a");
  if (!f) { printf("fopen a2 failed\n"); return 1; }
  fputs("CCC", f);
  fclose(f);

  /* Read back */
  f = fopen(path, "r");
  if (!f) { printf("fopen r failed\n"); return 1; }
  char buf[64];
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, sizeof(buf), f);
  fclose(f);

  printf("content: %s\n", buf);
  if (strcmp(buf, "AAABBBCCC") == 0) {
    printf("PASS\n");
  } else {
    printf("FAIL\n");
    return 1;
  }
  return 0;
}
