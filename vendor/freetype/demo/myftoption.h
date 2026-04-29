/*
 * Custom FreeType options for C-to-WASM compiler.
 * Include original defaults, then override what we don't support.
 */
#ifndef MYFTOPTION_H_
#define MYFTOPTION_H_

/* Get the default options first */
#include <freetype/config/ftoption.h>

/* No getenv in WASM */
#undef FT_CONFIG_OPTION_ENVIRONMENT_PROPERTIES

/* No Mac resource forks */
#undef FT_CONFIG_OPTION_MAC_FONTS

/* No compression libraries needed */
#undef FT_CONFIG_OPTION_USE_LZW
#undef FT_CONFIG_OPTION_USE_ZLIB

/* Disable bytecode interpreter (complex, 184KB ttinterp.c) */
#undef TT_CONFIG_OPTION_BYTECODE_INTERPRETER

/* Requires bytecode interpreter */
#undef TT_CONFIG_OPTION_SUBPIXEL_HINTING

/* Variable fonts not needed */
#undef TT_CONFIG_OPTION_GX_VAR_SUPPORT

/* BDF table not needed */
#undef TT_CONFIG_OPTION_BDF

/* No inline assembly in WASM */
#define FT_CONFIG_OPTION_NO_ASSEMBLER

#endif /* MYFTOPTION_H_ */
