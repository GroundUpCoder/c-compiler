/* Exercises the environ-backed environment libc: getenv/setenv/unsetenv/
   putenv/clearenv plus a direct walk of `environ`. The environment starts
   empty (the host did not seed it via __set_environ in this harness), so the
   first mutation deep-copies the empty block to the heap. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

extern char **environ;

int main(void) {
  printf("home0=%s\n", getenv("HOME") ? getenv("HOME") : "(null)");

  setenv("HOME", "/root", 1);
  printf("home1=%s\n", getenv("HOME"));

  setenv("HOME", "/other", 0);   /* overwrite=0 keeps the existing value */
  printf("home2=%s\n", getenv("HOME"));

  setenv("HOME", "/root2", 1);   /* overwrite=1 replaces it */
  printf("home3=%s\n", getenv("HOME"));

  setenv("USER", "root", 1);
  int n = 0;
  for (char **e = environ; *e; e++) n++;
  printf("count=%d\n", n);

  putenv("PATH=/bin");
  printf("path=%s\n", getenv("PATH"));

  putenv("PATH=/usr/bin");       /* putenv replaces an existing var */
  printf("path2=%s\n", getenv("PATH"));

  unsetenv("HOME");
  printf("home4=%s\n", getenv("HOME") ? getenv("HOME") : "(null)");

  errno = 0;
  int r = setenv("BAD=NAME", "x", 1);   /* '=' in name → EINVAL */
  printf("badname r=%d einval=%d\n", r, errno == EINVAL);

  clearenv();
  printf("cleared user=%s empty=%d\n",
         getenv("USER") ? getenv("USER") : "(null)",
         environ[0] == NULL);

  return 0;
}
