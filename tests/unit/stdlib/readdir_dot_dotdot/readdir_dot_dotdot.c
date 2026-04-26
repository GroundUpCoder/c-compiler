/*
 * Test: readdir should return "." and ".." entries
 *
 * Bug: Node.js fs.opendirSync().readSync() does NOT return "." and ".."
 * entries. POSIX requires readdir() to include them in every directory.
 * Many C programs rely on their presence (e.g., to count entries,
 * detect empty directories, or as a baseline assumption).
 */
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <fcntl.h>

int main(void) {
  mkdir("__test_readdir_dots", 0755);

  DIR *dir = opendir("__test_readdir_dots");
  if (!dir) {
    printf("FAIL: opendir\n");
    return 1;
  }

  struct dirent *ent;
  int has_dot = 0, has_dotdot = 0;
  while ((ent = readdir(dir)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0) has_dot = 1;
    if (strcmp(ent->d_name, "..") == 0) has_dotdot = 1;
  }
  closedir(dir);
  rmdir("__test_readdir_dots");

  printf("has_dot: %d\n", has_dot);
  printf("has_dotdot: %d\n", has_dotdot);
  return 0;
}
