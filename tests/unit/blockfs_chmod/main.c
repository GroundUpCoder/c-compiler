#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main() {
  FILE *f = fopen("/perm.txt", "w"); fclose(f);

  if (chmod("/perm.txt", 0600) != 0) { printf("FAIL: chmod"); return 1; }

  struct stat st;
  if (stat("/perm.txt", &st) != 0) { printf("FAIL: stat"); return 2; }
  if ((st.st_mode & 07777) != 0600) {
    printf("FAIL: mode=0%o", st.st_mode & 07777); return 3;
  }

  printf("OK: chmod");
  return 0;
}
