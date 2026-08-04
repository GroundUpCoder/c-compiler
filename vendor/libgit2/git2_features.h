/* Features header for compiling libgit2 with c-compiler (WASM target).
   This replaces the cmake-generated git2_features.h. */

#ifndef INCLUDE_features_h__
#define INCLUDE_features_h__

/* Include WASM compatibility shims early */
#include "wasm-compat.h"

/* No threading — use the single-threaded TLS fallback */
#undef GIT_THREADS

/* SHA1: use bundled collision-detecting SHA1 (the "builtin" backend).
 * Must be GIT_SHA1_BUILTIN — that is the macro hash/sha.h and libgit2.c
 * actually check to pull in collisiondetect.h and complete
 * git_hash_sha1_ctx. See features.h for the full rationale. */
#define GIT_SHA1_BUILTIN 1

/* SHA256: use builtin */
#define GIT_SHA256_BUILTIN 1

/* Compression: use zlib */
#define GIT_COMPRESSION_ZLIB 1

/* Regex: use bundled PCRE2.
 *
 * PCRE2's API macros must be set before src/util/regexp.h reads pcre2.h.
 * They used to arrive as -D flags in bin.json/lib.json; ticket #473 moved
 * the config into headers so a gucman `srclib` package (which cannot carry
 * compilerArgs) builds the same bytes. The matching PCRE2-internal build
 * config lives in deps/pcre2/config.h; these three are the caller-visible
 * half, #ifndef-guarded so the two agree wherever both are read. */
#define GIT_REGEX_PCRE2 1
#ifndef PCRE2_CODE_UNIT_WIDTH
#define PCRE2_CODE_UNIT_WIDTH 8
#endif
#ifndef PCRE2_STATIC
#define PCRE2_STATIC 1
#endif
#ifndef PCRE2_EXPORT
#define PCRE2_EXPORT
#endif

/* HTTP parser: use bundled llhttp */
#define GIT_HTTPPARSER_LLHTTP 1

/* No SSH */
#undef GIT_SSH

/* No HTTPS */
#undef GIT_HTTPS

/* But keep HTTP transport for local smart protocol */
#define GIT_HTTP 1

/* NTLM auth with builtin crypto */
#define GIT_AUTH_NTLM 1
#define GIT_AUTH_NTLM_BUILTIN 1

/* Platform: 64-bit */
#define GIT_ARCH_64 1

/* No qsort preference — use libgit2's built-in insertsort fallback */
#undef GIT_QSORT_C11
#undef GIT_QSORT_GNU
#undef GIT_QSORT_BSD
#undef GIT_QSORT_MSC

/* No nanosecond stat (WASM doesn't have it) */
#undef GIT_NSEC

/* No iconv */
#undef GIT_I18N

/* No futimens */
#undef GIT_FUTIMENS

/* Random: stub — no getentropy/getloadavg */
#undef GIT_RAND_GETENTROPY
#undef GIT_RAND_GETLOADAVG

/* IO: use select (supported by c-compiler WASM runtime) */
#define GIT_IO_SELECT 1

/* No mmap: the WASM runtime has no mmap(2), so src/util/unix/map.c compiles
 * its "unsupported" body and indexer.c takes its read()-based path. This was
 * a -DNO_MMAP flag until ticket #473 moved the build config into headers.
 * (features.h carries the same line, but nothing includes features.h — see
 * the note at the top of that file. git2_util.h includes THIS header, which
 * is how map.c, posix.c and indexer.c reach the macro.) */
#define NO_MMAP 1

/* Build info */
#define GIT_BUILD_CPU "wasm32"
#define GIT_BUILD_COMMIT "vendor"

#endif
