/* M0 PROBE SHIM — libc surface compiler.js does not provide.
 *
 * Force-included from pyconfig.h.  Every entry here is a MISSING LIBC SURFACE
 * finding, not a compiler defect: each is a standard C or POSIX function that
 * wasi-libc/musl/glibc all have and compiler.js's builtin header set does not.
 * They are stubbed/implemented here only so the probe can see what lies BEHIND
 * them.  The real versions belong in compiler.js's libc.
 *
 * Split into two groups:
 *   (a) NO CONFIGURE ESCAPE — CPython calls these unconditionally, so a real
 *       port MUST have them: fma, gmtime_r, wcstol, isascii.
 *   (b) has a HAVE_* knob — turned off in pyconfig.h instead of shimmed.
 */
#ifndef _CCPROBE_LIBC_H
#define _CCPROBE_LIBC_H

#include <stddef.h>
#include <time.h>
#include <wchar.h>
#include <math.h>

/* --- (a) no configure escape ------------------------------------------- */

/* C99 <math.h> 7.12.13.1 — absent from compiler.js's math.h. */
double fma(double x, double y, double z);

/* POSIX <time.h> — absent; CPython's Python/pytime.c calls it unconditionally. */
struct tm *gmtime_r(const time_t *timep, struct tm *result);

/* C95 <wchar.h> — absent; Python/initconfig.c calls it unconditionally. */
long wcstol(const wchar_t *nptr, wchar_t **endptr, int base);

/* XSI <ctype.h> — absent; Modules/_decimal/_decimal.c calls it. */
#ifndef isascii
#define isascii(c) (((unsigned)(c)) < 128u)
#endif

/* --- struct tm::tm_zone ------------------------------------------------- */
/* compiler.js's <time.h> has tm_gmtoff but not tm_zone.  There IS a configure
 * knob (HAVE_STRUCT_TM_TM_ZONE) so this is group (b) and is turned off in
 * pyconfig.h — recorded here because the two fields are conventionally a pair
 * and shipping one without the other is the surprising half. */

/* POSIX <string.h>/<strings.h> — absent. Needed by Modules/_blake2 (its only
   alternative is a GCC inline-asm memory barrier). */
void explicit_bzero(void *s, size_t n);

/* POSIX <time.h> — absent. Modules/timemodule.c calls tzset() whenever
   struct tm has no tm_zone. */
void tzset(void);

/* POSIX <time.h> — absent, and Python/pytime.c calls it with NO HAVE_ guard
   (inside #ifdef HAVE_CLOCK_GETTIME), so a port cannot configure around it. */
int clock_getres(clockid_t clk_id, struct timespec *res);

/* POSIX <unistd.h> — absent; Modules/posixmodule.c. Has a HAVE_ knob. */
int truncate(const char *path, off_t length);

#endif /* _CCPROBE_LIBC_H */


/* ---- M0 numpy probe: libc surface compiler.js's <math.h> lacks -------------
 * On this target long double IS double (SIZEOF_LONG_DOUBLE 8), so the C99
 * `l`-suffixed forms are plain aliases. numpy calls them unconditionally. */
#define sinl(x)   sin(x)
#define cosl(x)   cos(x)
#define tanl(x)   tan(x)
#define sinhl(x)  sinh(x)
#define coshl(x)  cosh(x)
#define tanhl(x)  tanh(x)
#define expl(x)   exp(x)
#define exp2l(x)  exp2(x)
#define expm1l(x) expm1(x)
#define logl(x)   log(x)
#define log2l(x)  log2(x)
#define log10l(x) log10(x)
#define log1pl(x) log1p(x)
#define powl(x,y)     pow(x,y)
#define sqrtl(x)      sqrt(x)
#define fabsl(x)      fabs(x)
#define floorl(x)     floor(x)
#define ceill(x)      ceil(x)
#define fmodl(x,y)    fmod(x,y)
#define hypotl(x,y)   hypot(x,y)
#define atan2l(x,y)   atan2(x,y)
#define copysignl(x,y) copysign(x,y)
#define fmaxl(x,y)    fmax(x,y)
#define fminl(x,y)    fmin(x,y)
#define modfl(x,p)    modf((x),(p))
#define frexpl(x,e)   frexp((x),(e))
#define ldexpl(x,e)   ldexp((x),(e))
#define asinl(x)  asin(x)
#define acosl(x)  acos(x)
#define atanl(x)  atan(x)
#define nextafterl(x,y) nextafter(x,y)

/* C99 <math.h> 7.12.14 comparison macros — absent from compiler.js. */
#ifndef isgreater
#define isgreater(x,y)      ((x) > (y))
#define isgreaterequal(x,y) ((x) >= (y))
#define isless(x,y)         ((x) < (y))
#define islessequal(x,y)    ((x) <= (y))
#define islessgreater(x,y)  ((x) < (y) || (x) > (y))
#define isunordered(x,y)    (isnan(x) || isnan(y))
#endif

/* GCC/clang builtins compiler.js does not provide. */
#define __builtin_isnan(x)      isnan(x)
#define __builtin_isinf(x)      isinf(x)
#define __builtin_isfinite(x)   isfinite(x)
#define __builtin_prefetch(...) ((void)0)

/* POSIX <locale.h> xlocale — absent. */
typedef void *locale_t;
