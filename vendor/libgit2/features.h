/* Feature detection for compiling libgit2 with c-compiler (WASM target). */
#ifndef INCLUDE_features_h__
#define INCLUDE_features_h__

/* No threading — use the single-threaded TLS fallback */
#undef GIT_THREADS

/* SHA1: use bundled collision-detecting SHA1 (the "builtin" backend).
 * The code (hash/sha.h, libgit2.c) gates inclusion of the completing
 * header collisiondetect.h on GIT_SHA1_BUILTIN — matching upstream
 * cmake/SelectHashes.cmake, which sets GIT_SHA1_BUILTIN for USE_SHA1=builtin.
 * Defining the unread GIT_SHA1_COLLISIONDETECT instead left
 * git_hash_sha1_ctx forward-declared (incomplete) in every TU that includes
 * hash.h but not collisiondetect.h, under-sizing git_hash_ctx (120 vs ~2408
 * bytes) and corrupting the caller's stack during hashing. */
#define GIT_SHA1_BUILTIN 1

/* SHA256: use builtin */
#define GIT_SHA256_BUILTIN 1

/* Compression: use zlib (already vendored in c-compiler) */
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

/* qsort */
#define GIT_QSORT_C11 1

/* No nanosecond stat (WASM doesn't have it) */
#undef GIT_NSEC

/* No iconv */
#undef GIT_I18N

/* No futimens */
#undef GIT_FUTIMENS

/* Random: stub */
#undef GIT_RAND_GETENTROPY
#undef GIT_RAND_GETLOADAVG

/* IO: use select (supported by c-compiler WASM runtime) */
#define GIT_IO_SELECT 1

/* No mmap */
#define NO_MMAP 1

/* Build info */
#define GIT_BUILD_CPU "wasm32"
#define GIT_BUILD_COMMIT "vendor"

#endif
