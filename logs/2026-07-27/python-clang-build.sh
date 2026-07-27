#!/bin/sh
# python-clang — build CPython 3.13.5 with the clang-simplified cc2wasm
# toolchain, over the SAME source list / defines / include set that
# logs/2026-07-27/cpython-m0-minlink.sh feeds to compiler.js.
#
# The only variable between the two artifacts is the compiler: same 174 TUs,
# same generated pyconfig.h + Modules/config.c + frozen_modules, same libc
# (cc2wasm reuses c-compiler's own wasm/libc), same host.js "c"-env ABI.
#
#   R=<build-root> SRCS=<this-dir>/python-clang-srcs.txt sh python-clang-build.sh
#
# R must contain cpython/ (the pristine 3.13.5 tree) and ccbuild/ (the generated
# pyconfig.h + Modules/config.c + Python/frozen_modules/ + shim/, all of which
# come from a wasi-sdk configure — compiler.js cannot generate them). SRCS is
# read relative to R.
set -eu
R=${R:-$HOME/build/python-clang}
S=$R/cpython
B=$R/ccbuild
SRCS=${SRCS:-$(cd "$(dirname "$0")" && pwd)/python-clang-srcs.txt}
CC2WASM=${CC2WASM:-$HOME/git/clang-simplified/cc2wasm}
SHIM=${SHIM:-$(cd "$(dirname "$0")" && pwd)/python-clang-shim.h}
OUT=${OUT:-$R/python-clang.wasm}

# wcstol is the ONE symbol the probe's shim and the sibling's vendored libc both
# supply: compiler.js's libc has no wide integer parsers, so BOTH projects filled
# the same hole independently (the sibling as wasm/libc-ext/__wcsto.c). Renaming
# the shim's copy to a private symbol keeps the compiler.js build's own
# implementation in force for BOTH artifacts — the alternative (dropping the
# shim's) would silently swap implementations between the two sides of the A/B.
# The sibling's __wcsto.c then goes unreferenced and wasm-ld GCs it.
cd "$R"
exec "$CC2WASM" \
  -include "$SHIM" \
  -Dwcstol=__ccprobe_wcstol \
  -DPy_BUILD_CORE \
  -DPREFIX='"/usr/local"' -DEXEC_PREFIX='"/usr/local"' -DVERSION='"3.13"' \
  -DVPATH='""' -DPLATLIBDIR='"lib"' -DPYTHONPATH='""' -DPYTHONFRAMEWORK='""' \
  -DRTLD_NODELETE=0 -DRTLD_NOLOAD=0 -DSOABI='"cpython-313-wasm32-gucos"' \
  -DABIFLAGS='""' -DPY_CORE_CFLAGS='""' -DPY_CORE_LDFLAGS='""' -DPY_BUILD_CORE=1 \
  -DDATE='"xx/xx/xx"' -DTIME='"xx:xx:xx"' \
  -I"$B" -I"$B/shim" -I"$S/Include/internal" -I"$S/Include/internal/mimalloc" \
  -I"$B/Objects" -I"$B/Include" -I"$B/Python" -I"$S/Include" -I"$S/Modules" \
  -Wl,-z,stack-size=8388608 \
  "$@" \
  $(cat "$SRCS") \
  -o "$OUT"
