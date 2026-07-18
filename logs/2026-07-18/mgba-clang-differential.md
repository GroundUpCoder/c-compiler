# mGBA clang golden-build differential

**Date:** 2026-07-18  
**Refs:** `todos/0140-mgba-cpu-miscompile.md`, `todos/MGBA.md`  
**Toolchain branch:** clang-simplified `mgba-parity`  
**c-compiler branch:** `mgba-clang`

## Result

The real-ROM result pins Mario Tennis's compiler.js-only derail on compiler.js
code generation: the clang build runs the same mGBA sources and ROM through the
same `host.js`, passes the previously fatal crt0 branch, and reaches the game's
language-selection screen. It never prints `Jumped to invalid address:
09000000`.

The jsmolka result is more nuanced and corrects the broader prior claim that
all CPU-suite failures are necessarily compiler.js miscompiles. Clang does not
pass either suite:

| ROM | compiler.js (prior controlled run) | clang differential |
| --- | --- | --- |
| `arm.gba` | `Failed test 235` | `Failed test 235` |
| `thumb.gba` | `Failed test 230` | `Failed test 102` |
| Mario Tennis | derails in crt0; `Jumped to invalid address: 09000000`; white frame | clean execution beyond crt0; BIOS/DMA/save activity; language-selection screen |

Thus the exact real-game `09000000` bug is pinned on compiler.js, but the
jsmolka failures cannot be used as a clean compiler.js-only oracle. The shared
ARM failure and clang-specific earlier THUMB failure require a separate
investigation of wasm/port assumptions, ABI/layout, undefined behavior, or
other shared differences from native mGBA.

## Build

The build used all 78 entries from `vendor/mgba/bin.json`, its compiler args
minus compiler.js-only `--allow-zero-length-arrays`, and the four manifest
include directories:

```sh
SRCS=(${(f)"$(node -e 'const j=require("./bin.json"); process.stdout.write(j.sources.join("\n"))')"})
ARGS=(${(f)"$(node -e 'const j=require("./bin.json"); process.stdout.write(j.compilerArgs.filter(x=>x!=="--allow-zero-length-arrays").join("\n"))')"})
CC2WASM_CLANG=~/git/clang-simplified/simple1/out/clang \
  ~/worktree/clang-simplified/mgba-parity/cc2wasm --sdl $ARGS \
  -Iinclude -Isrc -Isrc/third-party/blip_buf -Isrc/third-party/inih \
  $SRCS -o mgba-clang.wasm
```

It linked successfully at 635,925 bytes. There were no missing symbols and no
consumer-side compatibility shims. Clang emitted only pre-existing warnings:
one `time_t` format mismatch, eight `PRIXPTR` format mismatches, the frontend's
`GBA_H` macro redefinition, `vsnprintf` builtin redeclaration, a generated-libc
NUL-character warning, and two `noreturn` warnings.

## libc parity fills

The reusable clang libc was regenerated from c-compiler commit `440aaaf88a76`
using `wasm/tools/extract-libc.js`, preserving clang-simplified's vendor
invariant. The mGBA-blocking fills are real implementations, not macros or
builtin bridges:

- `exp2` and `exp2f`: declarations in `<math.h>` and implementations using
  `exp(x * ln(2))`, with the float wrapper delegating to the double function.
- `rewinddir`: declaration in `<dirent.h>`; `DIR` retains the opened path,
  reopens it into a new host directory handle, then closes the old handle.
  `opendir` also closes its host handle if allocation fails. No host ABI import
  was added.
- Angle-include parity: confirmed by compiling all 78 mGBA TUs with their
  upstream-style `<mgba/...>` and standard-library angle includes.
- `__builtin_bswap16/32/64` parity: confirmed by compiling mGBA's endian macros
  in `include/mgba-util/common.h` without a workaround.

Because the vendor invariant is all-or-nothing, the regeneration also adopts
already-accumulated additive c-compiler libc drift: SDL system cursors,
`SDL_WaitEvent*`, popup-window subsidiary headers/TU, and small related SDL,
WebGPU, and `unistd.h` updates. These are additional concrete parity items but
are not referenced by mGBA's link unless used. No further libc gap surfaced in
the 78-TU build or runtime boot.

Validation:

- `check-libc-vendor.sh`: green against the clean c-compiler worktree.
- reused musl functional suite: 34 passed, 0 failed.
- mGBA: all 78 TUs compiled and linked; `exp2f`, `rewinddir`, angle includes,
  and bswap built with no defines or source changes.

## Differential evidence

Commands used the same c-compiler `host.js`:

```sh
node host.js vendor/mgba/mgba-clang.wasm /path/to/arm.gba
node host.js vendor/mgba/mgba-clang.wasm /path/to/thumb.gba
node host.js vendor/mgba/mgba-clang.wasm /path/to/mariotennis.gba
```

The jsmolka verdict is framebuffer text rather than stdout. An
environment-gated, temporary null-SDL pixel dump was used only to read that
text; it was removed before commit and did not change the wasm or emulation.
The captured frames read `Failed test 235` and `Failed test 102` respectively.

For Mario Tennis, stdout immediately diverges from compiler.js after
`mgba: GBA core ready (MARIOTENNISA)`: clang continues through valid DMA, BIOS,
audio, save detection, and rendering for the full ten-second run. Across 2,500+
log lines it emits no invalid-address or illegal-opcode message. The captured
frame shows the English/Deutsch/Français/Español/Italiano language selector,
which is direct proof that it booted well beyond crt0.

No binary, overlay, `image.json`, or deploy change is included.
