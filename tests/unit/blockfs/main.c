#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

int main() {
  // Write a file
  FILE *f = fopen("/hello.txt", "w");
  if (!f) { printf("FAIL: fopen write"); return 1; }
  fwrite("blockfs functional", 1, 19, f);
  fclose(f);

  // Read it back
  f = fopen("/hello.txt", "r");
  if (!f) { printf("FAIL: fopen read"); return 2; }
  char buf[50] = {0};
  int n = fread(buf, 1, 50, f);
  fclose(f);

  // Check stat
  struct stat st;
  if (stat("/hello.txt", &st) != 0) { printf("FAIL: stat"); return 3; }
  if (st.st_size != 19) { printf("FAIL: stat size %ld", (long)st.st_size); return 4; }

  printf("%.*s", n, buf);
  return 0;
}
