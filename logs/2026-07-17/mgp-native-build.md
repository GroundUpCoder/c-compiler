# MagicPoint native macOS reference build

MagicPoint now builds and runs as an arm64 macOS process on the `mgp-native`
worktree.  The build compiles the source lists from MagicPoint and the vendored
FreeType 2.14.1, libpng 1.6.58, giflib 5.2.2, and zlib trees directly with
Apple clang.  No dependency source was downloaded and no package manager was
used.

## Build and run

From the repository root:

```sh
vendor/magicpoint/build-native.sh /tmp/mgp-native
MGP_FONT="$PWD/vendor/freetype/demo/robotomono.ttf" \
MGP_ASSET_DIR="$PWD/vendor/magicpoint" \
/tmp/mgp-native vendor/magicpoint/decks/text.mgp
```

The existing `os/gcode/build-native.sh` convention supplies clang C11 warning
flags, debug info, and AddressSanitizer.  MagicPoint follows that convention.
Its extra dependency flags match `vendor/magicpoint/bin.json`.

The repository has SDL declarations for its wasm libc but no SDL3 native source
or prebuilt library at commit `2990b95`.  This machine already has a universal
arm64/x86_64 `libSDL3.dylib` in Steam's application runtime.  The script uses
that existing library by default, or an explicitly supplied `SDL3_LIBRARY`, and
copies it beside the output because its install name is
`@loader_path/libSDL3.dylib`.  The committed `native/SDL.h` is the small public
SDL3 ABI subset used by `sdlx.c`; it avoids requiring a separately installed
header SDK.  If neither local library exists, the script fails with an explicit
request for `SDL3_LIBRARY`.

## Native portability fixes

- The wasm animation-frame callback becomes a normal SDL event/render loop
  under `MGP_NATIVE`.
- SDL's native window surface on this machine is RGB565.  `XFlush` now handles
  both 16-bit RGB565 and 32-bit surfaces with their actual row pitch; ASan found
  the former 32-bit-only write overflowing the SDL surface.
- Three old K&R definitions had undeclared integer parameters under modern
  clang.  Their declarations now match their existing prototypes.
- The deck parser's in-place leading escape removal uses `memmove`; ASan caught
  the overlapping `memcpy` on the colors deck.
- libpng NEON is disabled because the vendored wasm-oriented source manifest
  does not include libpng's ARM assembly objects.
- `MGP_FONT` points seeded `/usr/share/fonts/mono.ttf` references at the bundled
  Roboto Mono, and `MGP_ASSET_DIR` maps seeded `/usr/share/mgp/*` image paths to
  the bundled assets without modifying decks.
- `MGP_NATIVE_SHOT` writes the final 0x00RRGGBB MagicPoint canvas through the
  vendored libpng.  Repeated flushes replace the requested deck shot during
  rendering.

## Verification

- `vendor/magicpoint/build-native.sh /tmp/mgp-native`: succeeds; output is a
  Mach-O 64-bit arm64 executable with ASan.
- Launched every requested showcase/tutorial deck and `demo.mgp` at a selected
  page in a real SDL window, allowed it to settle, captured its canvas, and
  terminated it through MagicPoint's signal cleanup.
- `file native-shots/*.png`: all 13 outputs are non-interlaced 800x600 8-bit RGB
  PNGs.
- Visually inspected representative text, gray-ramp, GIF stretch/rotation, and
  gradient screenshots.

The checked screenshots are in `native-shots/` and cover all seven showcase
decks, the five requested tutorial decks, and `demo.mgp`.
