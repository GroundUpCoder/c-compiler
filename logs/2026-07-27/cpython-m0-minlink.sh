#!/bin/sh
S=/tmp/cpy-m0/cpython; B=/tmp/cpy-m0/ccbuild
exec node ${CCJS:-/tmp/cpy-m0/compiler-patched.js} --no-version-check -a "${ACT:-compile}" \
  -DPy_BUILD_CORE \
  -DPREFIX='"/usr/local"' -DEXEC_PREFIX='"/usr/local"' -DVERSION='"3.13"' \
  -DVPATH='""' -DPLATLIBDIR='"lib"' -DPYTHONPATH='""' -DPYTHONFRAMEWORK='""' \
  -DRTLD_NODELETE=0 -DRTLD_NOLOAD=0 -DSOABI='"cpython-313-wasm32-gucos"' \
  -DABIFLAGS='""' -DPY_CORE_CFLAGS='""' -DPY_CORE_LDFLAGS='""' -DPY_BUILD_CORE=1 \
  -I$B -I$B/shim -I$S/Include/internal -I$S/Include/internal/mimalloc \
  -I$B/Objects -I$B/Include -I$B/Python -I$S/Include -I$S/Modules \
  "$@" $(cat /tmp/cpy-m0/min-srcs.txt)
