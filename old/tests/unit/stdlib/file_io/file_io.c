#include <stdio.h>
#include <string.h>

int main() {
  const char *path = TEST_TMPDIR "file_io.txt";
  const char *msg = "Hello, FILE!";
  size_t len = strlen(msg);

  /* Write to file */
  FILE *f = fopen(path, "w");
  if (!f) {
    printf("fopen write failed\n");
    return 1;
  }
  size_t written = fwrite(msg, 1, len, f);
  printf("written: %d\n", (int)written);
  fclose(f);

  /* Read back */
  char buf[64];
  memset(buf, 0, sizeof(buf));
  f = fopen(path, "r");
  if (!f) {
    printf("fopen read failed\n");
    return 1;
  }
  size_t nread = fread(buf, 1, sizeof(buf), f);
  printf("read: %d\n", (int)nread);
  fclose(f);

  printf("content: %s\n", buf);
  if (strcmp(buf, msg) == 0) {
    printf("PASS\n");
  } else {
    printf("FAIL\n");
    return 1;
  }
  return 0;
}
