/* ccprobe_clang.h — the clang-side-ONLY compat header for the python-clang
 * build.  -include'd by cc-build.sh; NEVER seen by the compiler.js build, so
 * logs/2026-07-27/cpython-m0-shim/ stays byte-identical between the two.
 *
 * Two deltas, both toolchain-boundary artifacts rather than CPython issues:
 *
 * 1. pread/pwrite.  c-compiler's <unistd.h> grew them in 1794b618 (NetSurf
 *    Lane 1).  clang-simplified's wasm/libc is a MECHANICAL extraction of
 *    that same libc, but pinned at c-compiler 2b6bfb7a — 206 commits back —
 *    so its unistd.h predates them and Modules/posixmodule.c (HAVE_PREAD=1,
 *    HAVE_PWRITE=1 in the generated pyconfig.h) fails to compile.  The two
 *    definitions below are copied VERBATIM from compiler.js's unistd.h, so
 *    the two artifacts get identical semantics rather than a feature gap.
 *    The general fix is a libc re-vendor in the sibling repo — todos/0328.
 *
 * 2. __minstack.  A compiler.js dialect directive (it sets the wasm stack
 *    size); clang has no such thing and takes -Wl,-z,stack-size=8388608
 *    instead, which cc-build.sh passes.  Neutralised as a macro here so the
 *    shared ccprobe_libc.c needs no #ifdef.
 */
#ifndef CCPROBE_CLANG_H
#define CCPROBE_CLANG_H

#include <unistd.h>

/* Positioned I/O (POSIX pread/pwrite). The process model is single-
   threaded, so save/seek/io/restore over the shared file offset is
   race-free; a non-seekable fd fails with lseek's own errno (ESPIPE). */
static inline long pread(int fd, void *buf, unsigned long count, long long offset) {
  long long save = lseek(fd, 0, SEEK_CUR);
  if (save < 0) return -1;
  if (lseek(fd, offset, SEEK_SET) < 0) return -1;
  long r = read(fd, buf, (long)count);
  lseek(fd, save, SEEK_SET);
  return r;
}
static inline long pwrite(int fd, const void *buf, unsigned long count, long long offset) {
  long long save = lseek(fd, 0, SEEK_CUR);
  if (save < 0) return -1;
  if (lseek(fd, offset, SEEK_SET) < 0) return -1;
  long r = write(fd, buf, (long)count);
  lseek(fd, save, SEEK_SET);
  return r;
}

/* `__minstack(N);` at file scope -> a harmless extern declaration. */
#define __minstack(n) extern int __cc_minstack_is_a_link_flag_under_clang

#endif /* CCPROBE_CLANG_H */
