#!/bin/sh
# The compiler.js side of the A/B — cpython-m0-minlink.sh reading the SAME
# python-clang-srcs.txt out of the SAME build root as python-clang-build.sh, so
# the two artifacts differ only in the compiler. ACT defaults to the emit
# (`compile`); `link` is the link CHECK and writes no file.
#
#   CCJS=<patched-compiler.js> R=<build-root> sh python-clang-ccjs-build.sh [--gc-sections]
#
# ⚠️ CCJS must be a compiler.js carrying the still-open todos/0320 + 0321 + 0323
# patches. SHIPPED compiler.js cannot build CPython: it dies in the preprocessor
# with "RangeError: Maximum call stack size exceeded" at the 0320 spread site.
set -eu
R=${R:-$HOME/build/python-clang}
S=$R/cpython
B=$R/ccbuild
SRCS=${SRCS:-$(cd "$(dirname "$0")" && pwd)/python-clang-srcs.txt}
CCJS=${CCJS:-$R/compiler-reprobe.js}
OUT=${OUT:-$R/python-ccjs.wasm}

cd "$R"
exec node "$CCJS" --no-version-check -a "${ACT:-compile}" \
  -DPy_BUILD_CORE \
  -DPREFIX='"/usr/local"' -DEXEC_PREFIX='"/usr/local"' -DVERSION='"3.13"' \
  -DVPATH='""' -DPLATLIBDIR='"lib"' -DPYTHONPATH='""' -DPYTHONFRAMEWORK='""' \
  -DRTLD_NODELETE=0 -DRTLD_NOLOAD=0 -DSOABI='"cpython-313-wasm32-gucos"' \
  -DABIFLAGS='""' -DPY_CORE_CFLAGS='""' -DPY_CORE_LDFLAGS='""' -DPY_BUILD_CORE=1 \
  -I"$B" -I"$B/shim" -I"$S/Include/internal" -I"$S/Include/internal/mimalloc" \
  -I"$B/Objects" -I"$B/Include" -I"$B/Python" -I"$S/Include" -I"$S/Modules" \
  "$@" \
  $(cat "$SRCS") \
  -o "$OUT"
