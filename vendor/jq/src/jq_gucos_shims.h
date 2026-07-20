#ifndef JQ_GUCOS_SHIMS_H
#define JQ_GUCOS_SHIMS_H
/* Prototypes for the gucOS wasm libc gap-fillers (see jq_gucos_shims.c).
   The repo's <time.h> does not declare these, so builtin.c pulls them in
   here. Guarded by the same HAVE_* macros bin.json defines. */
#include <time.h>

#ifdef HAVE_TIMEGM
time_t timegm(struct tm *tm);
#endif
#ifdef HAVE_GMTIME_R
struct tm *gmtime_r(const time_t *timep, struct tm *result);
#endif
#ifdef HAVE_STRPTIME
char *strptime(const char *s, const char *format, struct tm *tm);
#endif

#endif /* JQ_GUCOS_SHIMS_H */
