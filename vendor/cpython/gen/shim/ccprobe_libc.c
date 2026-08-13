/* M0 PROBE SHIM — libc gap-fillers for the building toolchain (now empty).
 *
 * TWO CONSUMERS compile this file (todos/CPYTHON.md §4.3): compiler.js via
 * bin.json, and ~/git/clang-simplified via its manifest reading the same
 * `sources` list.  This file used to carry fallback bodies for the libc
 * surface one or both toolchains lacked (gmtime_r, tzset, clock_getres,
 * truncate, wcstol, fma, explicit_bzero — the #539 seven):
 *
 *   - compiler.js's libc grew all seven (todos/0325 Group A et al.), which
 *     turned the bodies into duplicate definitions under compiler.js; #539
 *     guarded them `#ifdef __clang__` for the sibling's sake.
 *
 *   - clang-simplified's libc is a re-vendored snapshot of compiler.js's
 *     libc (todos/0330).  The #544 re-vendor advanced that pin past the
 *     0325 growth, so the sibling now gets all seven from its own libc too,
 *     and its `-Dwcstol=__ccprobe_wcstol` manifest rename is gone with it.
 *
 * Per the 0330 rule those bodies were pin-staleness artifacts, not permanent
 * surface — with the pin re-vendored they are deleted (#544).  If a future
 * libc gap re-opens here, prefer re-vendoring the sibling's pin over adding
 * bodies back; this file exists for surface NEITHER toolchain can provide.
 */

/* CPython needs a deep C stack (upstream WASI uses --wasm max-wasm-stack=8388608). */
__minstack(8388608);
