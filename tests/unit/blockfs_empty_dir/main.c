#include <stdio.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

int main() {
  // Create and immediately list an empty directory
  mkdir("/emptydir", 0755);
  DIR *d = opendir("/emptydir");
  if (!d) { printf("FAIL: opendir"); return 1; }

  int count = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) count++;
  closedir(d);

  // Should only have "." and ".."
  if (count != 2) { printf("FAIL: count=%d", count); return 2; }

  // rmdir should work on empty directory
  if (rmdir("/emptydir") != 0) { printf("FAIL: rmdir"); return 3; }

  printf("OK: empty dir");
  return 0;
}
