/* WASM compatibility shims for libgit2.
   Provides stubs for POSIX functions not available in the WASM runtime. */
#ifndef WASM_COMPAT_H
#define WASM_COMPAT_H

#include <time.h>
#include <unistd.h>
#include <sys/types.h>

/* strnlen — provide inline fallback */
#ifndef NO_STRNLEN
#define NO_STRNLEN
#endif

/* gmtime_r — the libc supplies it since todos/0325 Group A; the local
   static-inline copy now conflicts with that declaration. */

/* Process identity — stub to safe defaults for WASM */
static inline uid_t geteuid(void) { return 0; }
static inline uid_t getuid(void) { return 0; }
static inline gid_t getgid(void) { return 0; }
static inline pid_t getppid(void) { return 1; }
static inline pid_t getpgid(pid_t pid) { (void)pid; return 1; }
static inline pid_t getsid(pid_t pid) { (void)pid; return 1; }

/* hard links — not supported in WASM filesystem, stub with error */
#include <errno.h>
static inline int link(const char *oldpath, const char *newpath) {
    (void)oldpath; (void)newpath;
    errno = ENOSYS;
    return -1;
}

/* pread — read at offset without affecting file position */
static inline ssize_t pread(int fd, void *buf, size_t count, off_t offset) {
    off_t old = lseek(fd, 0, SEEK_CUR);
    if (old == (off_t)-1) return -1;
    if (lseek(fd, offset, SEEK_SET) == (off_t)-1) return -1;
    ssize_t n = read(fd, buf, count);
    lseek(fd, old, SEEK_SET);
    return n;
}

/* pwrite — write at offset without affecting file position */
static inline ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
    off_t old = lseek(fd, 0, SEEK_CUR);
    if (old == (off_t)-1) return -1;
    if (lseek(fd, offset, SEEK_SET) == (off_t)-1) return -1;
    ssize_t n = write(fd, buf, count);
    lseek(fd, old, SEEK_SET);
    return n;
}

/* sysconf constants not in WASM */
#ifndef _SC_GETPW_R_SIZE_MAX
#define _SC_GETPW_R_SIZE_MAX 1024
#endif

#endif /* WASM_COMPAT_H */
