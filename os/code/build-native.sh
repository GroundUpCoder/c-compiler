#!/bin/sh
# Build `code` natively (the reference oracle: real libcurl + real cJSON).
# The same code.c builds for gucOS against the 0173 libcurl veneer unchanged.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="${1:-/tmp/code}"
clang -std=c11 -Wall -Wextra -Wno-unused-parameter -g -fsanitize=address \
  -I"$root/vendor/cjson" \
  "$here/code.c" "$root/vendor/cjson/cJSON.c" \
  -lcurl -o "$out"
echo "built $out"
