#!/bin/sh
# Build the MagicPoint reference oracle natively from repository-vendored C.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="${1:-/tmp/mgp}"

# SDL3 itself is supplied as a prebuilt native library.  SDL3_LIBRARY may be
# used for another local copy; this machine's Steam runtime is the fallback.
sdl3="${SDL3_LIBRARY:-$HOME/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/libSDL3.dylib}"
if [ ! -f "$sdl3" ]; then
	echo "mgp native build: SDL3 library not found; set SDL3_LIBRARY" >&2
	exit 1
fi

mkdir -p "$(dirname "$out")"
outdir=$(cd "$(dirname "$out")" && pwd)

mgp_sources='mgp.c draw.c parse.c grammar.c scanner.c background.c globals.c unimap.c tfont.c postscript.c embed.c plist.c sdlx.c missing/strsep.c image/imagetypes.c image/new.c image/zio.c image/path.c image/misc.c image/zoom.c image/rotate.c image/clip.c image/bright.c image/reduce.c image/dither.c image/halftone.c image/smooth.c image/compress.c image/value.c image/png.c image/gif.c image/pbm.c image/xbitmap.c image/xpixmap.c'
ft_sources='src/base/ftbase.c src/base/ftsystem.c src/base/ftdebug.c src/base/ftinit.c src/base/ftbitmap.c src/base/ftmm.c src/base/ftsynth.c src/sfnt/sfnt.c src/truetype/truetype.c src/smooth/smooth.c src/psnames/psnames.c'
png_sources='png.c pngerror.c pngget.c pngmem.c pngpread.c pngread.c pngrio.c pngrtran.c pngrutil.c pngset.c pngtrans.c pngwio.c pngwrite.c pngwtran.c pngwutil.c'
gif_sources='dgif_lib.c gifalloc.c gif_err.c openbsd-reallocarray.c'
z_sources='src/adler32.c src/compress.c src/crc32.c src/deflate.c src/inflate.c src/inftrees.c src/inffast.c src/trees.c src/uncompr.c src/zutil.c'

set --
for src in $mgp_sources; do set -- "$@" "$here/$src"; done
for src in $ft_sources; do set -- "$@" "$root/vendor/freetype/$src"; done
for src in $png_sources; do set -- "$@" "$root/vendor/libpng/$src"; done
for src in $gif_sources; do set -- "$@" "$root/vendor/giflib/$src"; done
for src in $z_sources; do set -- "$@" "$root/vendor/zlib/$src"; done

clang -std=gnu11 -Wall -Wextra -Wno-unused-parameter -Wno-unused-variable \
	-Wno-sign-compare -Wno-pointer-sign -Wno-deprecated-declarations \
	-Wno-deprecated-non-prototype -Wno-macro-redefined \
	-g -fsanitize=address \
	-DFREETYPE -DUSE_PNG -DUSE_GIF -DNO_UNCOMPRESS -DRETSIGTYPE=void \
	-DMGP_NATIVE \
	-DPNG_ARM_NEON_OPT=0 \
	-DHAVE_UNISTD_H=1 -DHAVE_SYS_WAIT_H=1 -DTIME_WITH_SYS_TIME=1 \
	-DHAVE_USLEEP=1 -DHAVE_STDARG_H=1 -DHAVE_STRDUP=1 \
	-DFT2_BUILD_LIBRARY -DFT_MAKE_OPTION_SINGLE_OBJECT \
	-DFT_CONFIG_OPTION_NO_ASSEMBLER \
	-DFREETYPEFONTDIR='"vendor/freetype/demo"' \
	-I"$here/native" -I"$here" -I"$root/vendor/freetype/demo" \
	-I"$root/vendor/freetype/include" -I"$root/vendor/libpng" \
	-I"$root/vendor/giflib" -I"$root/vendor/zlib/src" \
	"$@" "$sdl3" -lm -o "$out"

# This SDL build's install name is @loader_path/libSDL3.dylib, so make the
# output self-contained and immediately runnable.
if ! cmp -s "$sdl3" "$outdir/libSDL3.dylib"; then
	cp "$sdl3" "$outdir/libSDL3.dylib"
fi

echo "built $out"
