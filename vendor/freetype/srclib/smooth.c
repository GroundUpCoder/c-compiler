/* srclib shim: an FS-require-able source must be a SELF-CONTAINED TU
   (win32 source-lib design §3.4) — required TUs share one global define
   set with no per-TU compilerArgs, so the build-config defines live in
   the file itself, ifndef-guarded so -D duplicates from project builds
   (lib.json compilerArgs) stay legal. */
#ifndef FT2_BUILD_LIBRARY
#define FT2_BUILD_LIBRARY
#endif
#ifndef FT_MAKE_OPTION_SINGLE_OBJECT
#define FT_MAKE_OPTION_SINGLE_OBJECT
#endif
#ifndef FT_CONFIG_OPTION_NO_ASSEMBLER
#define FT_CONFIG_OPTION_NO_ASSEMBLER
#endif
#include "../src/smooth/smooth.c"
