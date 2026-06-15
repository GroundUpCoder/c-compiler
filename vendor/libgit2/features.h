/* Feature detection for compiling libgit2 with c-compiler (WASM target). */
#ifndef INCLUDE_features_h__
#define INCLUDE_features_h__

/* No threading — use the single-threaded TLS fallback */
#undef GIT_THREADS

/* SHA1: use bundled collision-detecting SHA1 */
#define GIT_SHA1_COLLISIONDETECT 1

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
