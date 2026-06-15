#include <stdio.h>
#include <unistd.h>
#include <pwd.h>

/* getpwuid/getpwnam resolve the single root user; unknown ids/names are NULL. */
int main(void) {
  struct passwd *p = getpwuid(getuid());
  printf("name=%s\n", p ? p->pw_name : "(null)");
  printf("uid=%u gid=%u\n", p->pw_uid, p->pw_gid);
  printf("dir=%s shell=%s\n", p->pw_dir, p->pw_shell);
  printf("byname=%s\n", getpwnam("root") ? "root" : "(null)");
  printf("unknown_uid=%s\n", getpwuid(1000) ? "found" : "(null)");
  printf("unknown_name=%s\n", getpwnam("nobody") ? "found" : "(null)");
  return 0;
}
