#ifndef LA_CONFIG_H
#define LA_CONFIG_H
#define __LIBARCHIVE_CONFIG_H_INCLUDED 1
/* hand-generated libarchive config for the compiler.js ILP32 wasm target
 * (0350 measurement). Probed against the embedded libc; notable absences:
 * gmtime_r/ctime_r/timegm/tzset (plain gmtime/localtime exist),
 * fchdir/fstatat/openat/linkat/mkfifo/vfork. */

/* headers */
#define HAVE_CTYPE_H 1
#define HAVE_DIRENT_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_GRP_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LOCALE_H 1
#define HAVE_PWD_H 1
#define HAVE_SIGNAL_H 1
#define HAVE_STDARG_H 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UTSNAME_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_TIME_H 1
#define HAVE_UNISTD_H 1
#define HAVE_UTIME_H 1
#define HAVE_WCHAR_H 1
#define HAVE_WCTYPE_H 1
#define HAVE_ZLIB_H 1

/* libraries */
#define HAVE_LIBZ 1

/* functions */
#define HAVE_CHOWN 1
#define HAVE_FCHMOD 1
#define HAVE_FCNTL 1
#define HAVE_FSEEKO 1
#define HAVE_FSTAT 1
#define HAVE_FTRUNCATE 1
#define HAVE_GETEUID 1
#define HAVE_GETPID 1
#define HAVE_LINK 1
#define HAVE_LOCALTIME_R 1
#define HAVE_LSTAT 1
#define HAVE_MEMMOVE 1
#define HAVE_MKDIR 1
#define HAVE_MKSTEMP 1
#define HAVE_PIPE 1
#define HAVE_POLL 1
#define HAVE_READLINK 1
#define HAVE_SETENV 1
#define HAVE_SNPRINTF 1
#define HAVE_STRCHR 1
#define HAVE_STRDUP 1
#define HAVE_STRERROR 1
#define HAVE_STRRCHR 1
#define HAVE_SYMLINK 1
#define HAVE_UNSETENV 1
#define HAVE_UTIMES 1
#define HAVE_VSNPRINTF 1
#define HAVE_WCRTOMB 1
#define HAVE_WCSCMP 1
#define HAVE_WCSCPY 1
#define HAVE_WCSLEN 1
#define HAVE_WCTOMB 1
#define HAVE_MBRTOWC 1
#define HAVE_WMEMCMP 1
#define HAVE_WMEMCPY 1
#define HAVE_WMEMMOVE 1

/* types */
#define HAVE_WCHAR_T 1
#define HAVE_LONG_LONG_INT 1
#define HAVE_UINTMAX_T 1
#define HAVE_INTMAX_T 1
#define SIZEOF_WCHAR_T 4
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_SIZE_T 4
#define SIZEOF_OFF_T 8

/* measurement shims for libc gaps (real vendoring adds these to the libc):
 * umask(2) and id_t are absent from the embedded libc. */
#include <sys/types.h>
typedef unsigned int id_t;
static inline mode_t umask(mode_t m) { (void)m; return 0; }

#endif /* LA_CONFIG_H */
