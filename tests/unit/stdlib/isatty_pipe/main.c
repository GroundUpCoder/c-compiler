/* Regression: isatty() returned 1 for fds 0-2 unconditionally, even
 * when stdio is piped (as it is under this test runner). */
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>

int main(void) {
  printf("%d %d %d\n", isatty(0), isatty(1), isatty(2));
  int fd = open(TEST_TMPDIR "isatty_f.txt", O_WRONLY | O_CREAT, 0644);
  printf("%d %d\n", isatty(fd), isatty(99));
  close(fd);
  return 0;
}
