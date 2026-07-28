// BUG (found by todos/0382): BlockFS.mkdir accepted a mode argument and then
// DISCARDED it — every directory came out DEFAULT_DIR_MODE (0755), so
// mkdir("/priv", 0700) silently produced a world-readable directory. The
// mode is now honoured (masked by the process umask, like open's create
// path). umask is set to 0 here so this tests the mode plumbing alone.
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static void check(const char *path, mode_t req, int want) {
  struct stat st;
  if (mkdir(path, req) != 0) { printf("FAIL: mkdir %s\n", path); return; }
  if (stat(path, &st) != 0) { printf("FAIL: stat %s\n", path); return; }
  if (!S_ISDIR(st.st_mode)) { printf("FAIL: %s not a dir\n", path); return; }
  printf("%s %03o -> %03o (want %03o) %s\n", path, req,
         (unsigned)(st.st_mode & 0777), want,
         ((int)(st.st_mode & 0777) == want) ? "ok" : "MISMATCH");
}

int main(void) {
  umask(0);
  check("/d700", 0700, 0700);   // was 0755 before the fix
  check("/d750", 0750, 0750);
  check("/d777", 0777, 0777);
  check("/d755", 0755, 0755);
  return 0;
}
