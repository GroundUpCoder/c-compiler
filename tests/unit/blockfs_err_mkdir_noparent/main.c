#include <stdio.h>
#include <sys/stat.h>
#include <errno.h>

int main() {
  if (mkdir("/nope/subdir", 0755) == 0) { printf("FAIL: should fail"); return 1; }
  // The error should be ENOENT (parent doesn't exist)
  if (errno != ENOENT) { printf("FAIL: errno=%d expected %d", errno, ENOENT); return 2; }
  printf("OK: mkdir noparent");
  return 0;
}
