/* Hand-written config.h for the wasm build (replaces meson's generated one).
 * wasm32: ILP32, little-endian, single-threaded (CAIRO_NO_MUTEX + the
 * mutex-based atomic fallback in cairo-atomic.c, whose mutexes are no-ops). */
#ifndef CAIRO_WASM_CONFIG_H
#define CAIRO_WASM_CONFIG_H

#define CAIRO_NO_MUTEX 1

#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_FCNTL_H 1
#define HAVE_UINT64_T 1
#define HAVE_CLOCK_GETTIME 1

#define SIZEOF_VOID_P 4
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_SIZE_T 4

#endif
