/* M0 PROBE SHIM — implementations of the libc surface compiler.js lacks.
 * Every function here is a MISSING LIBC SURFACE finding.  These bodies are
 * throwaway probe scaffolding (correct enough to boot an interpreter, not
 * production libc); the real ones belong in compiler.js's libc.
 */
#include <stddef.h>
#include <string.h>
#include <time.h>
#include <wchar.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>

/* C99 7.12.13.1. Not a true fused multiply-add — no rounding guarantee. */
double fma(double x, double y, double z) { return x * y + z; }

/* POSIX. compiler.js's <time.h> has gmtime() but not the _r form. */
struct tm *gmtime_r(const time_t *timep, struct tm *result)
{
    struct tm *t = gmtime(timep);
    if (t == NULL) return NULL;
    *result = *t;
    return result;
}

/* POSIX. No TZ database in gucOS; everything is UTC. */
void tzset(void) { }

/* POSIX. compiler.js has clock_gettime but not clock_getres. */
int clock_getres(clockid_t clk_id, struct timespec *res)
{
    (void)clk_id;
    if (res) { res->tv_sec = 0; res->tv_nsec = 1000; }   /* 1us, matches host.js */
    return 0;
}

/* POSIX 2016 / OpenBSD. A memset the optimiser may not elide. */
void explicit_bzero(void *s, size_t n)
{
    volatile unsigned char *p = (volatile unsigned char *)s;
    while (n--) *p++ = 0;
}

/* C95 <wchar.h>. */
long wcstol(const wchar_t *nptr, wchar_t **endptr, int base)
{
    const wchar_t *p = nptr;
    long sign = 1, val = 0;
    int any = 0;
    while (*p == L' ' || (*p >= 9 && *p <= 13)) p++;
    if (*p == L'+' || *p == L'-') { if (*p == L'-') sign = -1; p++; }
    if ((base == 0 || base == 16) && p[0] == L'0' && (p[1] == L'x' || p[1] == L'X')) {
        p += 2; base = 16;
    } else if (base == 0) {
        base = (p[0] == L'0') ? 8 : 10;
    }
    for (;; p++) {
        int d;
        if (*p >= L'0' && *p <= L'9') d = (int)(*p - L'0');
        else if (*p >= L'a' && *p <= L'z') d = (int)(*p - L'a') + 10;
        else if (*p >= L'A' && *p <= L'Z') d = (int)(*p - L'A') + 10;
        else break;
        if (d >= base) break;
        val = val * base + d;
        any = 1;
    }
    if (endptr) *endptr = (wchar_t *)(any ? p : nptr);
    return sign * val;
}

/* POSIX <unistd.h>. */
int truncate(const char *path, off_t length)
{
    int fd = open(path, O_WRONLY);
    int r;
    if (fd < 0) return -1;
    r = ftruncate(fd, length);
    close(fd);
    return r;
}

/* CPython needs a deep C stack (upstream WASI uses --wasm max-wasm-stack=8388608). */
__minstack(8388608);
