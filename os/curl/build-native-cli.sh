#!/bin/sh
# Build /bin/curl's source natively (real libcurl) — the gcode dual-target
# pattern (os/gcode/build-native.sh). The same curl-cli.c builds for gucOS
# against the 0173 veneer via os/curl/cli.json.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="${1:-/tmp/curl-cli}"
clang -std=c11 -Wall -Wextra -g "$here/curl-cli.c" -lcurl -o "$out"
echo "built $out"
