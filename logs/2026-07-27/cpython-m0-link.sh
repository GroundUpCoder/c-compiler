#!/bin/sh
S=/tmp/cpy-m0/cpython; B=/tmp/cpy-m0/ccbuild
exec node ${CCJS:-/tmp/cpy-m0/compiler-patched.js} --no-version-check -a "${ACT:-compile}" \
  --allow-old-c \
  -DPy_BUILD_CORE -D__USE_SYSTEM_ENDIAN_H__ \
  -DPREFIX='"/usr/local"' -DEXEC_PREFIX='"/usr/local"' -DVERSION='"3.13"' \
  -DVPATH='""' -DPLATLIBDIR='"lib"' -DPYTHONPATH='""' -DPYTHONFRAMEWORK='""' \
  -DRTLD_NODELETE=0 -DRTLD_NOLOAD=0 \
  -DCONFIG_32=1 -DANSI=1 -DHAVE_EXPAT_CONFIG_H -DUSE_PYEXPAT_CAPI -DXML_POOR_ENTROPY \
  -I$B -I$B/shim -I$S/Include/internal -I$S/Include/internal/mimalloc \
  -I$B/Objects -I$B/Include -I$B/Python -I$S/Include -I$S/Modules \
  -I$S/Modules/_decimal/libmpdec -I$S/Modules/expat -I$S/Modules/_hacl/include \
  -I$S/Modules/cjkcodecs \
  "$@" $(cat /tmp/cpy-m0/link-srcs.txt)
