/*
 * jconfig.h — hand-written configuration for the gucOS toolchain (0448 / #93).
 *
 * Upstream IJG libjpeg generates this file with `configure`; this repo has no
 * configure step, so the options are pinned here by hand (from jconfig.txt).
 * Target: this repo's C compiler, wasm32 ILP32, and — for the golden-test
 * generators — clang on a POSIX host. Both are ANSI C environments, so every
 * pre-ANSI escape hatch stays off:
 *
 *   HAVE_PROTOTYPES / HAVE_UNSIGNED_CHAR / HAVE_UNSIGNED_SHORT — ANSI, on.
 *   HAVE_STDDEF_H / HAVE_STDLIB_H — both headers exist in our libc, on.
 *   CHAR_IS_UNSIGNED — off: plain char is SIGNED on wasm32 (clang default)
 *     and in this compiler.
 *   NEED_BSD_STRINGS / NEED_SYS_TYPES_H — off: <string.h> is ANSI, size_t
 *     comes from <stddef.h>.
 *   NEED_FAR_POINTERS / NEED_SHORT_EXTERNAL_NAMES / INCOMPLETE_TYPES_BROKEN
 *     — off: no segmented memory, no 15-char linker cap, real ANSI compiler.
 *   RIGHT_SHIFT_IS_UNSIGNED — off: ">>" on signed values is an arithmetic
 *     shift (wasm shr_s) in both toolchains.
 *
 * The JPEG_CJPEG_DJPEG block exists only for the golden-test generators that
 * build cjpeg/djpeg natively from this same tree; the library proper never
 * reads it. PPM is the one interchange format those generators use.
 */

#define HAVE_PROTOTYPES
#define HAVE_UNSIGNED_CHAR
#define HAVE_UNSIGNED_SHORT
#undef CHAR_IS_UNSIGNED
#define HAVE_STDDEF_H
#define HAVE_STDLIB_H
#undef NEED_BSD_STRINGS
#undef NEED_SYS_TYPES_H
#undef NEED_FAR_POINTERS
#undef NEED_SHORT_EXTERNAL_NAMES
#undef INCOMPLETE_TYPES_BROKEN

#ifdef JPEG_INTERNALS

#undef RIGHT_SHIFT_IS_UNSIGNED

#endif /* JPEG_INTERNALS */

#ifdef JPEG_CJPEG_DJPEG

#define PPM_SUPPORTED
#undef BMP_SUPPORTED
#undef GIF_SUPPORTED
#undef RLE_SUPPORTED
#undef TARGA_SUPPORTED
#undef TWO_FILE_COMMANDLINE
#undef NEED_SIGNAL_CATCHER
#undef DONT_USE_B_MODE
#undef PROGRESS_REPORT

#endif /* JPEG_CJPEG_DJPEG */
