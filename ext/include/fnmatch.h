#ifndef _FNMATCH_H
#define _FNMATCH_H

/* POSIX <fnmatch.h> for compiler.js, backed by musl's fnmatch.c (ext/src). */

__require_source("fnmatch.c");

#define FNM_PATHNAME    0x1
#define FNM_NOESCAPE    0x2
#define FNM_PERIOD      0x4
#define FNM_LEADING_DIR 0x8
#define FNM_CASEFOLD    0x10
#define FNM_FILE_NAME   FNM_PATHNAME

#define FNM_NOMATCH 1
#define FNM_NOSYS   (-1)

int fnmatch(const char *, const char *, int);

#endif /* _FNMATCH_H */
