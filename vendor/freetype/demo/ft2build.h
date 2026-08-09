/*
 * Custom ft2build.h for C-to-WASM compiler.
 * Redirects FreeType config to our custom headers.
 */
#ifndef FT2BUILD_H_
#define FT2BUILD_H_

#define FT_CONFIG_OPTIONS_H  <myftoption.h>
#define FT_CONFIG_MODULES_H  <myftmodule.h>

#include <freetype/config/ftheader.h>

/* ---------------- the freetype require block (source-lib design §4.2,
 * ticket #464) ----
 * Including this header IS the link metadata: one ft2build.h serves both
 * build flavors (the windows.h/§4.1 pattern). Host-side project builds
 * (vendor/freetype/lib.json lists these TUs explicitly and its srcRoots
 * {freetype: srclib} resolves each name to the SAME path, so the
 * compiler's path-identity dedup no-ops the require — baked binaries
 * byte-identical); the in-OS cc resolves them via /usr/local/src ->
 * /usr/src (the srclib install tiers, planted by the standalone freetype
 * package), so a bare `cc app.c` with `#include <ft2build.h>` pulls the
 * whole library with no -I flags and no TU list. The set below MUST
 * equal vendor/freetype/lib.json sources — the §4.4 drift gate
 * (os-common win32RequireDriftErrors, run by tools/mkpkg.js +
 * tools/win32ports.js --check) enforces it. Each shim is a
 * SELF-CONTAINED TU (the three build defines live in-file, §3.4).
 *
 * FT_NO_REQUIRE_SOURCES (the WIN32_NO_REQUIRE_SOURCES of this library)
 * suppresses the block for a consumer that wants the declarations
 * without the sources. Macro state is per-TU; required-source NAMES
 * dedup per-compile. */
#ifndef FT_NO_REQUIRE_SOURCES
__require_source("freetype/ftbase.c");
__require_source("freetype/ftsystem.c");
__require_source("freetype/ftdebug.c");
__require_source("freetype/ftinit.c");
__require_source("freetype/autofit.c");
__require_source("freetype/ftbitmap.c");
__require_source("freetype/ftmm.c");
__require_source("freetype/ftsynth.c");
__require_source("freetype/sfnt.c");
__require_source("freetype/truetype.c");
__require_source("freetype/smooth.c");
__require_source("freetype/psnames.c");
#endif /* !FT_NO_REQUIRE_SOURCES */

#endif /* FT2BUILD_H_ */
