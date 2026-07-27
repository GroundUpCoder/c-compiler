#!/bin/sh
# bench-2x2: build MicroPython for a given (toolchain, heap) cell.
#
#   sh mp-build.sh <ours|clang> <256k|32m> <out.wasm>
#
# Both toolchains read the SAME expanded source list + include set out of the
# vendored bin.json, so the only variable across the axis is the compiler --
# the same discipline logs/2026-07-27/python-clang-build.sh applies to CPython.
#
# NOTE the one thing that is NOT symmetric, and cannot be made so:
# bin.json carries compilerArgs ["--gc-spill-locals"], a compiler.js dialect
# flag that forces scalar pointer/integer locals into the linear-memory shadow
# stack. MicroPython's GC is CONSERVATIVE -- it finds roots by scanning the C
# stack -- and wasm locals live outside linear memory, invisible to any scan.
# clang has no equivalent knob at -O2. This is recorded as a comparability
# caveat, not silently papered over.
set -eu
TC=${1:?toolchain}
HEAP=${2:?heap}
OUT=${3:?out}

B=$HOME/build/bench2x2
ROOT=$B/mp-$HEAP
CCJS=${CCJS:-$B/compiler-v176-0323probe.js}
CC2WASM=${CC2WASM:-$HOME/git/clang-simplified/cc2wasm}

# Expand bin.json -> newline-separated source list (paths relative to ROOT).
SRCS=$(node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1] + "/bin.json", "utf8"));
console.log(j.sources.join("\n"));
' "$ROOT")

cd "$ROOT"

case "$TC" in
  ours)
    exec node "$CCJS" --no-version-check -a compile \
      --gc-spill-locals \
      -I. -Igenhdr \
      $SRCS \
      -o "$OUT"
    ;;
  clang)
    exec "$CC2WASM" \
      -I. -Igenhdr \
      $SRCS \
      -o "$OUT"
    ;;
  *) echo "unknown toolchain $TC" >&2; exit 2 ;;
esac
