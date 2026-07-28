#!/bin/sh
# todos/0350 — build the three measurement binaries and print the size table.
# Run tools/zipmeasure/fetch.sh first. Outputs land in build/zipmeasure/out.
set -e
cd "$(dirname "$0")/../.."
OUT=build/zipmeasure/out
mkdir -p $OUT

for t in baseline libzip libarchive; do
  node compiler.js tools/zipmeasure/zt-$t/bin.json -o $OUT/$t.wasm
done

echo "--- functional check (each must print OK) ---"
node host.js $OUT/baseline.wasm $OUT/base.bin
node host.js $OUT/libzip.wasm $OUT/libzip.zip
node host.js $OUT/libarchive.wasm $OUT/libarchive.zip

echo "--- sizes (raw / gzip -9) ---"
for t in baseline libzip libarchive; do
  raw=$(wc -c < $OUT/$t.wasm | tr -d ' ')
  gz=$(gzip -9 -c $OUT/$t.wasm | wc -c | tr -d ' ')
  echo "$t: $raw / $gz"
done
