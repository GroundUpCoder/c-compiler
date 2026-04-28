# DOOM

DOOM (doomgeneric port).

- **Source**: https://github.com/ozkl/doomgeneric
- **License**: GPL v2 (see LICENSE)
- **Nuked-OPL3**: LGPL v2.1 (see Nuked-OPL3/LICENSE), from https://github.com/nukeykt/Nuked-OPL3

Sources were copied from the doomgeneric repository. The `data/doom1.wad` file
is the shareware version of DOOM.

## Structure

- `src/` — DOOM engine source files
- `Nuked-OPL3/` — OPL3 audio emulator for music synthesis
- `data/` — game data (doom1.wad)

## Modifications from upstream

The following files are modified from the upstream doomgeneric sources.

### Added files

- **`src/main.c`** — Custom emscripten+SDL platform implementation
  (`DG_Init`, `DG_DrawFrame`, `DG_SleepMs`, `DG_GetTicksMs`, `DG_GetKey`,
  `DG_SetWindowTitle`). Replaces upstream's per-platform files
  (`doomgeneric_emscripten.c`, `doomgeneric_sdl.c`, etc.).

- **`src/dg_sound.c`** — Custom SDL queue-based sound module. Replaces
  upstream's `i_sdlsound.c`/`i_sdlmusic.c` and removes the SDL_mixer
  dependency.

### Changed files

- **`src/doomfeatures.h`** — Enables `FEATURE_SOUND` (commented out upstream).

- **`src/doomtype.h`** — Removes `#include <stdbool.h>` and simplifies the
  `boolean` typedef to use `bool` directly, instead of upstream's
  `unsigned int` guarded by `__bool_true_false_are_defined`.

- **`src/i_sound.c`** — Removes `#include <SDL_mixer.h>` (replaced by
  `dg_sound.c`).

- **`src/f_finale.c`** — Moves the `stopattack:` label and its code out of a
  nested `if` block to function scope. The compiler does not support goto
  into nested blocks (WebAssembly structured control flow limitation).

- **`src/p_map.c`** — Same goto restructuring: moves the `stairstep:` label
  out of an `if` block to function scope.

### Omitted upstream files

Makefiles, Visual Studio project files, platform-specific `doomgeneric_*.c`
files, `icon.c`, `gusconf.c/h`, `mus2mid.c/h`, and SDL audio backends
(`i_sdlmusic.c`, `i_sdlsound.c`, `i_allegromusic.c`, `i_allegrosound.c`).
