/*
 * Custom ft2build.h for C-to-WASM compiler.
 * Redirects FreeType config to our custom headers.
 */
#ifndef FT2BUILD_H_
#define FT2BUILD_H_

#define FT_CONFIG_OPTIONS_H  <myftoption.h>
#define FT_CONFIG_MODULES_H  <myftmodule.h>

#include <freetype/config/ftheader.h>

#endif /* FT2BUILD_H_ */
