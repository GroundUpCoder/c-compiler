#ifndef UTIL_H
#define UTIL_H

#ifdef WIN32
/* For WriteFile() below */
#include <windows.h>
#include <io.h>
#include <processenv.h>
#include <shellapi.h>
#include <wchar.h>
#include <wtypes.h>
#endif

#include "jv.h"

jv expand_path(jv);
jv get_home(void);
jv jq_realpath(jv);

/*
 * The Windows CRT and console are something else.  In order for the
 * console to get UTF-8 written to it correctly we have to bypass stdio
 * completely.  No amount of fflush()ing helps.  If the first byte of a
 * buffer being written with fwrite() is non-ASCII UTF-8 then the
 * console misinterprets the byte sequence.  But one must not
 * WriteFile() if stdout is a file!1!!
 *
 * We carry knowledge of whether the FILE * is a tty everywhere we
 * output to it just so we can write with WriteFile() if stdout is a
 * console on WIN32.
 */

static void priv_fwrite(const char *s, size_t len, FILE *fout, int is_tty) {
#ifdef WIN32
  if (is_tty)
    WriteFile((HANDLE)_get_osfhandle(fileno(fout)), s, len, NULL, NULL);
  else
    fwrite(s, 1, len, fout);
#else
  fwrite(s, 1, len, fout);
#endif
}

const void *_jq_memmem(const void *haystack, size_t haystacklen,
                       const void *needle, size_t needlelen);

/* gucOS wasm port: the upstream MIN/MAX use GNU statement-expressions
   ({ ... }) + __typeof__, which this repo's compiler doesn't support. jq's only
   use of these (jv.c's DEC_CONTEXT digit clamp) passes side-effect-free args,
   so the portable double-evaluating ternary form is safe here. */
#ifndef MIN
#define MIN(a,b) ((a) < (b) ? (a) : (b))
#endif
#ifndef MAX
#define MAX(a,b) ((a) > (b) ? (a) : (b))
#endif

#include <time.h>

#if defined(WIN32) && !defined(HAVE_STRPTIME)
char* strptime(const char *buf, const char *fmt, struct tm *tm);
#endif

#endif /* UTIL_H */
