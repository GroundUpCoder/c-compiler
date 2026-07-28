#!/bin/sh
# todos/0350 — fetch + unpack the two zip-library candidates into
# build/zipmeasure (gitignored). Pinned versions + checksums; refuses a
# checksum mismatch.
set -e
cd "$(dirname "$0")/../.."
mkdir -p build/zipmeasure
cd build/zipmeasure

LA_V=3.8.1
LA_SHA=bde832a5e3344dc723cfe9cc37f8e54bde04565bfe6f136bc1bd31ab352e9fab
LZ_V=1.11.4
LZ_SHA=82e9f2f2421f9d7c2466bbc3173cd09595a88ea37db0d559a9d0a2dc60dc722e

[ -f libarchive-$LA_V.tar.gz ] || curl -sSL -o libarchive-$LA_V.tar.gz \
  https://github.com/libarchive/libarchive/releases/download/v$LA_V/libarchive-$LA_V.tar.gz
[ -f libzip-$LZ_V.tar.gz ] || curl -sSL -o libzip-$LZ_V.tar.gz \
  https://github.com/nih-at/libzip/releases/download/v$LZ_V/libzip-$LZ_V.tar.gz

echo "$LA_SHA  libarchive-$LA_V.tar.gz" | shasum -a 256 -c -
echo "$LZ_SHA  libzip-$LZ_V.tar.gz" | shasum -a 256 -c -

[ -d libarchive-$LA_V ] || tar xzf libarchive-$LA_V.tar.gz
[ -d libzip-$LZ_V ] || tar xzf libzip-$LZ_V.tar.gz
echo "fetched: libarchive-$LA_V libzip-$LZ_V"
