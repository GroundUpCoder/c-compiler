#!/bin/sh
# Build `gcode` natively (the reference oracle: real libcurl + real cJSON).
# The same gcode.c builds for gucOS against the 0173 libcurl veneer unchanged.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="${1:-/tmp/gcode}"
# -DCJSON_NO_REQUIRE_SOURCES: cJSON.h carries a __require_source block for
# the gucOS compiler (source-lib §4.2, #662); clang gets the declarations
# only and links the explicitly listed cJSON.c below.
clang -std=c11 -Wall -Wextra -Wno-unused-parameter -g -fsanitize=address \
  -DCJSON_NO_REQUIRE_SOURCES \
  -I"$root/vendor/cjson" \
  "$here/gcode.c" "$root/vendor/cjson/cJSON.c" \
  -lcurl -o "$out"
echo "built $out"
