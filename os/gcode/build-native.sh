#!/bin/sh
# Build `gcode` natively (the reference oracle: real libcurl + real cJSON).
# The same gcode.c builds for gucOS against the 0173 libcurl veneer unchanged.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="${1:-/tmp/gcode}"
clang -std=c11 -Wall -Wextra -Wno-unused-parameter -g -fsanitize=address \
  -I"$root/vendor/cjson" \
  "$here/gcode.c" "$root/vendor/cjson/cJSON.c" \
  -lcurl -o "$out"
echo "built $out"
