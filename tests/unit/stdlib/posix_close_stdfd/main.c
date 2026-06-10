/* close() on std fds is valid per POSIX (returned EBADF). */
#include <stdio.h>
#include <unistd.h>

int main(void) {
  printf("close0=%d\n", close(0));
  printf("close0-again=%d\n", close(0));  /* now genuinely EBADF */
  return 0;
}
