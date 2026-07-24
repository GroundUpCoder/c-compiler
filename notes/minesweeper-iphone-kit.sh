#!/bin/sh
# ---------------------------------------------------------------------------
# Build + run @ProgrammingRainbow's Minesweeper-C-SDL3 IN gucOS, from source,
# on your iPhone (or any gucOS terminal). Paste this whole block into a gucOS
# shell (term / the VT1 console) and press Enter.
#
# It fetches the game's Video18/ tree straight from GitHub with the built-in
# /usr/bin/curl, compiles it in-OS with `cc *.c` (libpng + SDL3_image are
# built in), and launches it as a real window. Needs the libpng package
# (baked "Built-in" on the full image; else: gucman install libpng).
#
# Why per-file curl and not a tarball: raw.githubusercontent.com sends
# access-control-allow-origin:* (in-browser fetch is allowed), but GitHub's
# codeload .tar.gz endpoint does NOT — so /usr/bin/tar+gzip can't be fed from
# it in-browser. We curl each of the ~21 files instead. (curl, tar and gzip
# are all present in gucOS: `which curl tar gzip`.)
# ---------------------------------------------------------------------------
set -e
# The final sources live in Video18/; the shared art lives at the repo root
# images/ (the game loads "images/…" relative to its run dir).
REPO=https://raw.githubusercontent.com/ProgrammingRainbow/Minesweeper-C-SDL3/main
mkdir -p "$HOME/minesweeper/images"
cd "$HOME/minesweeper"

echo "fetching source…"
for f in main game board border clock face init_sdl load_media mines; do
    curl -sL "$REPO/Video18/$f.c" -o "$f.c"
    curl -sL "$REPO/Video18/$f.h" -o "$f.h"
done

echo "fetching art…"
for f in board borders digits digitback faces icon; do
    curl -sL "$REPO/images/$f.png" -o "images/$f.png"
done

# This cc is __STDC_NO_VLA__ (no variable-length arrays). game.c uses ONE VLA
# for the window-title buffer; swap it for a fixed buffer (the title is well
# under 60 chars). This is the only change to the upstream source.
sed -i 's/char title_str\[length\];/char title_str[512];/' game.c

echo "compiling in-OS (cc *.c — pulls libpng + zlib)…"
cc *.c -o minesweeper

echo "launching — left-click uncovers, right-click flags, 1-8 theme, face resets."
./minesweeper &
