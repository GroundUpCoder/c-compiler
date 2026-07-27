/* ccprobe_clang.h — the clang-side-ONLY compat header for the python-clang
 * build.  -include'd by cc-build.sh; NEVER seen by the compiler.js build, so
 * logs/2026-07-27/cpython-m0-shim/ stays byte-identical between the two.
 *
 * ONE delta remains, a toolchain-boundary artifact rather than a CPython issue:
 *
 * __minstack.  A compiler.js dialect directive (it sets the wasm stack
 * size); clang has no such thing and takes -Wl,-z,stack-size=8388608
 * instead, which cc-build.sh passes.  Neutralised as a macro here so the
 * shared ccprobe_libc.c needs no #ifdef.
 *
 * RETIRED (todos/0330): pread/pwrite used to be defined here, copied verbatim
 * out of compiler.js's <unistd.h>, because clang-simplified's wasm/libc was a
 * mechanical extraction pinned at c-compiler 2b6bfb7a — 225 commits behind the
 * 1794b618 (NetSurf Lane 1) that added them — so its unistd.h predated them
 * and Modules/posixmodule.c (HAVE_PREAD=1, HAVE_PWRITE=1 in the generated
 * pyconfig.h) failed to compile.  0330 re-vendored the sibling's libc from
 * c-compiler 9fdaed52, so the real <unistd.h> supplies both and the copies are
 * gone.  Keep it that way: a re-appearing copy here means the pin went stale
 * again, not that the functions are missing.
 */
#ifndef CCPROBE_CLANG_H
#define CCPROBE_CLANG_H

#include <unistd.h>

/* `__minstack(N);` at file scope -> a harmless extern declaration. */
#define __minstack(n) extern int __cc_minstack_is_a_link_flag_under_clang

#endif /* CCPROBE_CLANG_H */
