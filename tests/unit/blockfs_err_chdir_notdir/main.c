#include <stdio.h>
#include <unistd.h>
#include <errno.h>

int main() {
  FILE *f = fopen("/file.txt", "w"); fclose(f);
  if (chdir("/file.txt") == 0) { printf("FAIL: chdir to file"); return 1; }
  if (errno != ENOTDIR) { printf("FAIL: errno=%d expected %d", errno, ENOTDIR); return 2; }
  if (chdir("/nope") == 0) { printf("FAIL: chdir nonexistent"); return 3; }
  if (errno != ENOENT) { printf("FAIL: errno=%d expected %d", errno, ENOENT); return 4; }
  printf("OK: chdir errors");
  return 0;
}
