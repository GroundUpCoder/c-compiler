/* config.h — hand-written for the gucOS wasm build of Oniguruma 6.9.9.
 *
 * Oniguruma's build normally generates this from src/config.h.in via autoconf.
 * The gucOS target is wasm32 (ILP32: 4-byte int/long/void*, 8-byte long long),
 * little-endian, single-threaded, with this repo's ISO C libc. All values below
 * are fixed properties of that target, not probed. */
#ifndef ONIG_GUCOS_CONFIG_H
#define ONIG_GUCOS_CONFIG_H

#define HAVE_ALLOCA 1
#define HAVE_ALLOCA_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define STDC_HEADERS 1

#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_VOIDP 4

#define PACKAGE "onig"
#define PACKAGE_NAME "onig"
#define PACKAGE_VERSION "6.9.9"
#define VERSION "6.9.9"

#endif /* ONIG_GUCOS_CONFIG_H */
