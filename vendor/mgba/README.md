# mGBA

Game Boy Advance emulator using the [mGBA](https://github.com/mgba-emu/mgba)
core (**v0.10.5**, upstream commit `26b7884`) with an SDL3 frontend written
against mGBA's `mCore` interface. Installed as `/bin/mgba` and the default
`.gba` handler (todos/0112; `0072` openwith store points `gba` here). This is
the **GBA** leg — the platform Peanut-GB (`/bin/gameboy`) and SameBoy
(`/bin/sameboy`) can't reach. It is **additive**: `.gb`/`.gbc` still default to
SameBoy, which stays the more accurate GB/GBC choice.

## Licensing — MPL-2.0 (file-scoped), the rest of the repo stays Apache-2.0

mGBA is **MPL-2.0** (see `LICENSE`). MPL is *file-level* copyleft, not viral
like the GPL, so — unlike a GPL core — there is no repo-wide license quarantine:

- Every mGBA-derived file under `vendor/mgba/` (the `src/**` core subset and all
  `include/**` headers) keeps its MPL-2.0 header; modifications to those files
  are published here (the patch table below).
- **`src/main.c` is our glue, not mGBA-derived — it is Apache-2.0** like the
  rest of the c-compiler tree. It talks to `mCore` through the public headers;
  it is not a modification of an MPL file.
- No file in the Apache tree `#include`s an mGBA header (grep-clean); mGBA
  knowledge flows only *into* `vendor/mgba/`.

## Build config — GBA-only, minimal, no external deps

Compiled with `-DM_CORE_GBA -DMINIMAL_CORE=1 -DDISABLE_THREADING` — the same
tier as mGBA's own OpenEmu build. 32-bit `color_t` (RGBA8888, matches the SDL
surface / WebGPU compositor). `MINIMAL_CORE=1` keeps `mCore.dirs` but drops
`inputMap` and, crucially, the video-logger / video-proxy / HLE-audio-mixer
machinery (the multithreaded-render path) so those `extra`/`feature` sources are
neither vendored nor linked. GBA runs on mGBA's **HLE BIOS** — no official BIOS
blob is embedded (unlike SameBoy's boot ROMs).

### Excluded (not vendored / not compiled)

- **Other cores**: the SM83/GB core is not built. Only `src/gb/audio.c` is
  compiled — GBA reuses the Game Boy PSG for its two legacy sound channels.
- **C++ / frontends**: `src/platform/**` (Qt, SDL app, libretro, …).
- **Optional deps, all dropped**: zlib, libpng, minizip, SQLite, LZMA — so no
  PNG screenshots, no zip/7z ROMs, no game-DB (`library.c`), no ELF ROMs.
- **Subsystems**: debugger, GDB stub, scripting/Lua, savestate rewind,
  mem-search, threading, SIO link (dolphin/lockstep), sharkport save import.
- The software renderer only (no GL renderer).

`version.c` is normally CMake-generated; a static copy is vendored.

## Controls

- Arrow keys = D-pad, `Z` = A, `X` = B, `A` = L, `S` = R
- Enter = Start, Right Shift = Select

## Usage

Build standalone (uses the built-in test ROM):

    node compiler.js vendor/mgba/bin.json -a compile -o mgba.html

Build/run with a ROM (`.gba` files are not vendored — bring your own):

    mgba /root/roms/game.gba &

With no ROM argument a built-in test ROM (a MODE 3 bitmap fill drawn by a few
hand-assembled ARM words) paints a solid red frame — the headless pixel-test
target, mirroring `/bin/gameboy` and `/bin/sameboy`'s bare mode. Kernel e2e:
`tests/kernel/test_mgba_e2e.js`.

## Patches to mGBA sources (all marked `PATCH(c-compiler)` in-source)

The compiler predefines `__MTOTS__`; port-compatibility patches are gated on it.
The upstream CPU-correctness backport applies to every build.

| File | Patch | Why |
| --- | --- | --- |
| `include/mgba-util/common.h` | `CONSTRUCTOR(FN)` drops `__attribute__((constructor))` under `__MTOTS__` | the compiler has no ctor-attribute / pre-main pass. The only users are `mLOG_DEFINE_CATEGORY` log-category registrars; without the ctor every category id stays 0 (all logs share the default category — a cosmetic loss, emulation unaffected) |
| `include/mgba/internal/gb/serialize.h` | GB-savestate `static_assert(sizeof == 0x11800)` gated off under `__MTOTS__` | the compiler ignores `#pragma pack`, so the packed **Game Boy** savestate struct sizes differently. Unused in this GBA-only build (pulled in only transitively via `gb/audio.c`; `GBASerializedState` uses natural alignment + explicit padding and its own assert holds). No savestate API is called by the frontend |
| `src/core/version.c` | vendored static (not CMake-generated) | no CMake in this build |
| `src/arm/isa-arm.c` | backport upstream `d031892e55` | v0.10.5 incorrectly flushes the ARM pipeline for CMP/CMN/TST/TEQ when the architecturally ignored `Rd` field encodes PC; jsmolka ARM test 235 catches this |

### Compiler improvements this port drove (in `compiler.js`, not mGBA patches)

- **Angle-include resolution**: `#include <string.h>` no longer resolves to a
  same-directory sibling (mGBA ships `include/mgba-util/string.h` next to a
  `common.h` that includes the system `<string.h>`). `<>` now searches `-I`
  paths + system headers before falling back to the including directory; `""`
  keeps current-dir-first. Standard C 6.10.2 behavior.
- `__builtin_bswap16/32/64` prelude macros.
- `exp2` / `exp2f` in `<math.h>`.
- `rewinddir` in `<dirent.h>` (re-opens by the name captured at `opendir`).
