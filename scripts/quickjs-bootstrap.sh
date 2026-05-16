#!/usr/bin/env bash
# Build QuickJS + run compiler.js inside it — the self-host bootstrap loop.
#
# Stage 1: our compiler builds QuickJS (C → wasm)
# Stage 2: QuickJS-on-wasm runs compiler.js itself (JS engine evaluates JS source)
# Stage 3 (future): compiler.js running in QuickJS compiles new C → wasm
#
# Run from repo root:
#   scripts/quickjs-bootstrap.sh
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${OUT:-/tmp/qjs.wasm}"

echo "[1/3] Building QuickJS to wasm..."
node compiler.js -o "$OUT" vendor/quickjs/bin.json
size=$(wc -c < "$OUT" | tr -d ' ')
echo "      → $OUT ($size bytes)"

echo ""
echo "[2/3] Direct eval smoke test..."
result=$(node host.js "$OUT" -e 'console.log(40 + 2)')
if [ "$result" != "42" ]; then
  echo "      FAIL: expected 42, got: $result"
  exit 1
fi
echo "      → 40 + 2 = 42 ✓"

echo ""
echo "[3/3] Loading compiler.js into QuickJS (the bootstrap step)..."
out=$(node host.js "$OUT" --std -e '
  try {
    std.evalScript(std.loadFile("compiler.js"));
    console.log("BOOTSTRAP_OK");
  } catch (e) { console.log("BOOTSTRAP_FAIL", e.message); }
' 2>&1 | tail -1)
if [ "$out" != "BOOTSTRAP_OK" ]; then
  echo "      FAIL: $out"
  echo ""
  echo "If you see 'stack underflow (op=36, pc=2052)', the --no-reuse-locals"
  echo "workaround in vendor/quickjs/bin.json may have been removed."
  echo "See todos/QUICKJS-SELF-HOST.md for the underlying compiler bug."
  exit 1
fi
echo "      → compiler.js loaded and evaluated inside QuickJS-on-wasm ✓"

echo ""
echo "Bootstrap loop is open. compiler.js now runs inside our QuickJS,"
echo "which was built by our compiler. One codegen bug fix away from"
echo "compiler.js compiling new C code from inside that QuickJS."
echo ""
echo "See:"
echo "  - vendor/quickjs/README.md       — vendor status + patches"
echo "  - todos/QUICKJS-SELF-HOST.md     — the remaining compiler bug to fix"
