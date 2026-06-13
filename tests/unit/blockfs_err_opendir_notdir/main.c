#include <stdio.h>
#include <dirent.h>
#include <errno.h>

int main() {
  // Create a regular file
  FILE *f = fopen("/afile.txt", "w");
  if (!f) { printf("FAIL: fopen"); return 1; }
  fclose(f);

  // opendir on a file should fail with ENOTDIR
  DIR *d = opendir("/afile.txt");
  if (d != NULL) { printf("FAIL: should be null"); return 2; }
  if (errno != ENOTDIR) { printf("FAIL: errno=%d expected %d", errno, ENOTDIR); return 3; }

  // opendir on non-existent should fail with ENOENT
  d = opendir("/nonexistent");
  if (d != NULL) { printf("FAIL: should be null"); return 4; }
  if (errno != ENOENT) { printf("FAIL: errno=%d expected %d", errno, ENOENT); return 5; }

  printf("OK: error paths");
  return 0;
}
