#!/bin/sh
# todos/0332 — build and run the four diag_reloop.c cells.
#
#   sh mk-reloop.sh <out-dir> [compiler.js] [steps]
#
# Absolute paths throughout (this box's shell resets cwd between calls, and a
# relative `node host.js` fails as a module-load error that reads like a very
# fast benchmark). Every cell's chain length is reported from the ARTIFACT via
# cmpchain.js, so "no chain" is a read of the emitted bytes, not an exit code.
set -eu
OUT=${1:?out dir}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CC=${2:-$ROOT/compiler.js}
STEPS=${3:-500000}
mkdir -p "$OUT"

for ops in 256 1024; do
  for irred in 0 1; do
    tag="ops$ops-irred$irred"
    node "$CC" -DOPS=$ops -DIRRED=$irred -o "$OUT/reloop-$tag.wasm" "$HERE/diag_reloop.c"
    # Assert on the artifact: a compile that printed nothing did not produce one.
    test -s "$OUT/reloop-$tag.wasm" || { echo "MISSING $OUT/reloop-$tag.wasm" >&2; exit 1; }
    printf '%s  ' "$tag"
    node "$ROOT/host.js" "$OUT/reloop-$tag.wasm" "$STEPS"
    node "$HERE/cmpchain.js" "$OUT/reloop-$tag.wasm" @big 2>/dev/null | head -3 | sed 's/^/    /'
  done
done
