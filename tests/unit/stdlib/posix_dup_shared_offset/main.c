/* Regression: dup()/dup2() copied the file position by value; POSIX
 * requires dup'd fds to share one open file description (offset). */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

int main(void) {
  const char *path = TEST_TMPDIR "dup_shared.txt";
  FILE *f = fopen(path, "w");
  fputs("abcdefghij", f);
  fclose(f);

  int fd = open(path, O_RDONLY);
  if (fd < 0) { puts("open failed"); return 1; }
  int fd2 = dup(fd);
  char b1[4] = {0}, b2[4] = {0}, b3[4] = {0};
  read(fd, b1, 3);
  read(fd2, b2, 3);   /* must continue where fd left off */
  printf("%s %s\n", b1, b2);

  lseek(fd, 1, SEEK_SET);   /* seek via one fd... */
  read(fd2, b3, 3);          /* ...must be visible via the other */
  printf("%s\n", b3);

  int fd3 = dup2(fd, 17);
  char b4[4] = {0};
  read(fd3, b4, 3);
  printf("%d %s\n", fd3, b4);
  close(fd); close(fd2); close(fd3);
  return 0;
}
