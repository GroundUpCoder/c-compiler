#include <stdio.h>
#include <unistd.h>
#include <string.h>

int main() {
  FILE *f = fopen("/target.txt", "w");
  fwrite("symlinked data", 1, 14, f);
  fclose(f);

  if (symlink("/target.txt", "/link.txt") != 0) {
    printf("FAIL: symlink"); return 1;
  }

  // readlink should return the target path
  char buf[100] = {0};
  int n = readlink("/link.txt", buf, 100);
  if (n <= 0) { printf("FAIL: readlink n=%d", n); return 2; }
  buf[n] = 0;
  if (strcmp(buf, "/target.txt") != 0) {
    printf("FAIL: target=%s", buf); return 3;
  }

  printf("OK: symlink");
  return 0;
}
