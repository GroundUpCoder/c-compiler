#include <stdio.h>
#include <unistd.h>

/* Single root user: real and effective user/group IDs are all 0. */
int main(void) {
  printf("uid=%u\n", getuid());
  printf("euid=%u\n", geteuid());
  printf("gid=%u\n", getgid());
  printf("egid=%u\n", getegid());
  return 0;
}
