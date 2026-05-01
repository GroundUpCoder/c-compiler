#include <stdio.h>
#include <string.h>

int main() {
  const char *path = TEST_TMPDIR "fprintf_file.txt";

  /* Write formatted data to file */
  FILE *f = fopen(path, "w");
  if (!f) { printf("fopen write failed\n"); return 1; }
  fprintf(f, "count=%d\n", 42);
  fprintf(f, "name=%s\n", "hello");
  fprintf(f, "hex=%x\n", 255);
  fputc('Z', f);
  fputc('\n', f);
  fclose(f);

  /* Read back entire file */
  f = fopen(path, "r");
  if (!f) { printf("fopen read failed\n"); return 1; }
  char buf[256];
  memset(buf, 0, sizeof(buf));
  size_t n = fread(buf, 1, sizeof(buf), f);
  fclose(f);

  printf("bytes read: %d\n", (int)n);
  printf("content:\n%s", buf);

  /* Verify expected content */
  const char *expected = "count=42\nname=hello\nhex=ff\nZ\n";
  if (strcmp(buf, expected) == 0) {
    printf("PASS\n");
  } else {
    printf("FAIL\n");
    return 1;
  }
  return 0;
}
