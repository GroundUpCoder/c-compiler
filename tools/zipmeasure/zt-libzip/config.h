#ifndef HAD_CONFIG_H
#define HAD_CONFIG_H
#ifndef _HAD_ZIPCONF_H
#include "zipconf.h"
#endif
/* hand-generated for the compiler.js wasm target (0350 measurement).
 * Probed against the embedded libc: fileno/fseeko/ftello/localtime_r/
 * mkstemp/strcasecmp/strdup/strtoll/strtoull/fdopen/fchmod all present;
 * arc4random absent (falls back to /dev/urandom). */
#define ENABLE_FDOPEN
#define HAVE_FILENO
#define HAVE_FCHMOD
#define HAVE_FSEEKO
#define HAVE_FTELLO
#define HAVE_LOCALTIME_R
#define HAVE_MKSTEMP
#define HAVE_SNPRINTF
#define HAVE_STRCASECMP
#define HAVE_STRDUP
#define HAVE_STRTOLL
#define HAVE_STRTOULL
#define HAVE_STDBOOL_H
#define HAVE_STRINGS_H
#define HAVE_UNISTD_H
#define HAVE_DIRENT_H
#define SIZEOF_OFF_T 8
#define SIZEOF_SIZE_T 4
#define PACKAGE "libzip"
#define VERSION "1.11.4"

/* libzip expects strcasecmp declared by the platform's standard headers;
 * ours lives in <strings.h>, which no libzip TU includes directly. */
#include <strings.h>

#endif /* HAD_CONFIG_H */
