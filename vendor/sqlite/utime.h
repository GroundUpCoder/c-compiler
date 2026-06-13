/* Shim. SQLite's shell.c includes <utime.h> but actually uses utimes()
 * (with the 's', declared in <sys/time.h>), not utime(). The header is
 * effectively dead include for our build, but provide the symbols
 * anyway so any code that does use them gets a compilable stub. */
#ifndef _UTIME_H_SHIM
#define _UTIME_H_SHIM
#include <sys/types.h>

struct utimbuf {
  time_t actime;
  time_t modtime;
};

static inline int utime(const char *path, long atime, long mtime) {
  (void)path; (void)atime; (void)mtime;
  return 0;  /* no-op: succeed silently */
}
#endif
