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

/* Regex: use bundled PCRE2 */
#define GIT_REGEX_PCRE2 1

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

/* Build info */
#define GIT_BUILD_CPU "wasm32"
#define GIT_BUILD_COMMIT "vendor"

#endif
