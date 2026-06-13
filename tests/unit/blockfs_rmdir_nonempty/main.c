#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>

int main() {
  mkdir("/hasfiles", 0755);
  FILE *f = fopen("/hasfiles/child.txt", "w");
  if (!f) { printf("FAIL: fopen"); return 1; }
  fclose(f);

  // rmdir on non-empty should fail with ENOTEMPTY
  if (rmdir("/hasfiles") == 0) { printf("FAIL: rmdir should fail"); return 2; }
  if (errno != ENOTEMPTY) { printf("FAIL: errno=%d expected %d", errno, ENOTEMPTY); return 3; }

  // Clean up and verify rmdir works after removal
  unlink("/hasfiles/child.txt");
  if (rmdir("/hasfiles") != 0) { printf("FAIL: rmdir after cleanup"); return 4; }

  printf("OK: rmdir nonempty");
  return 0;
}
