/* PCRE2 build configuration for the c-compiler (WASM) target.
 *
 * Upstream generates this file from deps/pcre2/config.h.in with CMake or
 * autoconf; that template is deliberately not vendored here (see
 * vendor/libgit2/README.md, "What is deliberately NOT vendored"). Until
 * ticket #473 the values arrived as -D flags in bin.json / lib.json
 * compilerArgs. A gucman `srclib` package cannot carry compiler flags —
 * validateSrclibShape accepts only `include` and `src` — so the config lives
 * here, where the in-OS `cc` and the host build read the SAME bytes.
 *
 * pcre2_internal.h defines HAVE_CONFIG_H (one recorded edit) and includes this
 * file; every PCRE2 translation unit reaches it that way.
 *
 * Every macro below was the value of a former -D flag, and every one of them
 * is load-bearing with ONE exception: removing any of them individually fails
 * the build, except PCRE2_STATIC, whose removal left byte-identical output
 * (measured by ablation at ticket #473, 2026-08-04). PCRE2_STATIC is kept
 * anyway — it is the switch upstream's export logic is written against, and
 * its inertness here is a property of this port's single-binary link model,
 * not a guarantee. The one former flag that is NOT reproduced below is
 * -DHAVE_LONG_LONG=1: it has no reference anywhere in the vendored tree and
 * its removal is likewise byte-identical, so it was cruft (README records it).
 *
 * Guards: each macro is #ifndef-guarded so a -D duplicate stays legal (the
 * "self-contained TU" rule from the freetype srclib shims).
 */

#ifndef GUC_PCRE2_CONFIG_H
#define GUC_PCRE2_CONFIG_H

/* ---- API/link model ------------------------------------------------------
 * Static link, 8-bit code units. PCRE2_CODE_UNIT_WIDTH must be set before
 * pcre2.h is read; libgit2's own consumers get it from git2_features.h. */
#ifndef PCRE2_CODE_UNIT_WIDTH
#define PCRE2_CODE_UNIT_WIDTH 8
#endif

#ifndef PCRE2_STATIC
#define PCRE2_STATIC 1
#endif

/* Empty: nothing is exported from a static single-binary link. */
#ifndef PCRE2_EXPORT
#define PCRE2_EXPORT
#endif

/* ---- compiled-pattern layout --------------------------------------------
 * 2-byte link size: upstream's default and the only size the vendored
 * pre-generated tables were built for. */
#ifndef LINK_SIZE
#define LINK_SIZE 2
#endif

/* ---- named-subpattern limits (upstream config.h.in defaults) ------------- */
#ifndef MAX_NAME_SIZE
#define MAX_NAME_SIZE 32
#endif

#ifndef MAX_NAME_COUNT
#define MAX_NAME_COUNT 10000
#endif

/* ---- match-time resource limits (upstream config.h.in defaults) ---------- */
#ifndef MATCH_LIMIT
#define MATCH_LIMIT 10000000
#endif

#ifndef MATCH_LIMIT_DEPTH
#define MATCH_LIMIT_DEPTH 10000000
#endif

/* Heap the match engine may claim, in kibibytes — effectively unbounded, the
 * value the former -DHEAP_LIMIT flag carried. */
#ifndef HEAP_LIMIT
#define HEAP_LIMIT 20000000
#endif

#ifndef PARENS_NEST_LIMIT
#define PARENS_NEST_LIMIT 250
#endif

#ifndef MAX_VARLOOKBEHIND
#define MAX_VARLOOKBEHIND 512
#endif

/* ---- newline convention --------------------------------------------------
 * 10 = PCRE2_NEWLINE_LF. git patterns are LF-terminated. */
#ifndef NEWLINE_DEFAULT
#define NEWLINE_DEFAULT 10
#endif

#endif /* GUC_PCRE2_CONFIG_H */
