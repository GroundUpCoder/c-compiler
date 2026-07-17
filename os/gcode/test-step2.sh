#!/bin/sh
# Deterministic Step 2 coverage: canned SSE usage, JSONL ordering, and resume.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${TMPDIR:-/tmp}/gcode-step2-test
clang -std=c11 -Wall -Wextra -Werror -Wno-unused-parameter -g \
  -I"$root/vendor/cjson" \
  "$here/gcode.c" "$root/vendor/cjson/cJSON.c" \
  -lcurl -o "$out"
"$out" --no-color --self-test
