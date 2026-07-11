# 0088 — puNES NES/Famicom core (`/bin/punes`)

Landed puNES (`punesemu/puNES` @ `2ed5b1b`, 2025-12-31) as the NES emulator leg.
Fourth emulator after 0075 SameBoy (GB/GBC), 0112 mGBA (GBA), and the lighter
`/bin/gameboy`. puNES is the *accuracy* tier — cycle-accurate 6502/2C02/2A03,
second only to Mesen on the test-ROM suites — and, unlike Mesen/ares, its
emulation **core is plain C**. Port lives in `vendor/punes/`; seeded as
`/bin/punes`, Games-menu entry, and the `.nes → /bin/punes` openwith default.

## Frontend approach: fresh glue, not the recovered SDL frontend

The 0088 item suggested recovering puNES's pre-Qt SDL frontend from git history
as scaffold. I didn't — the modern core's `gui_*`/`gfx_*`/`snd_*` seam has
drifted far enough from the 2010-era SDL frontend that re-deriving the globals
against *today's* headers was cleaner than reconciling a 15-year-old frontend.
The seam is a set of TUs under `frontend/`:

- `main.c` hand-runs the power-on sequence (`memmap_init` → `pn_config_defaults`
  → `ppu_init` → `emu_turn_on`), then one NES frame per host animation frame
  (`emu_frame`). It reads the PPU's completed palette-index buffer
  (`nes[0].p.ppu_screen.last_completed_wr`) **directly** and maps it through an
  RGB NES palette into the SDL window surface — the whole `gfx` scaler/shader
  pipeline is bypassed (its seam in `pn_gfx.c` is book-keeping + no-ops).
- `pn_snd.c` drains blip_buf/handler into a ring `main.c` pushes to SDL audio;
  `pn_config.c` supplies the `_config cfg` defaults; `pn_seam.c` is the
  `gui_*`/`log_*` seam (OS utils real, cosmetic ones stubbed).
- `pn_orphan.c` defines the global instances upstream only declares in
  `core/compilation_unit_orphan.h` (which is `#include`d solely by the excluded
  Qt `main.c`) — this was the bulk of the link-stage undefined-symbol wall.
- `shim/` holds C-safe replacement headers for the platform/Qt tree
  (`qt.h`, `os_jstick.h` with the Linux input-event constants, no-op
  `pthread.h`, `compiled.h`, …).

**GPL quarantine** (per the item): puNES is GPLv2-or-later; `vendor/punes/` is
GPLv3 (`LICENSE`), electing v3 for the combined work. The rest of the repo
stays Apache — the compiler/OS *compile and host* puNES but never *link* it, and
the SDL3 impl is a puNES-agnostic library it merely consumes. Verified
grep-clean: no Apache-tree file `#include`s a puNES header.

## Excluded from the build

- **C++ the compiler can't build**: `src/c++/` (xBRZ, l7zip, the real
  crc/pic16c5x) and the C++ expansion-audio DSP under `core/mappers/`
  (`upd7756`, `hc55516`, `butterworth`, `waveFile`, their `*_interface.cpp`).
  Reimplemented in C what the core actually links: `src/c++/crc/crc.c` (a plain
  CRC-32) and `src/c++/pic16c5x/pic16c5x.c` (a no-op stub); `pn_dsp_stub.c`
  stubs the five exotic DSP chips. The handful of carts needing real expansion
  audio are dropped for v1.
- **Decompression**: raw `.nes`/`.fds` only for v1 — `uncompress.c`/`unif.c`
  (zip/7z via the C++ `l7zip`) are excluded, same call we'd have made for
  fixNES. miniz (C) stays for the formats that use it internally.
- Qt `main.c`, `emu_thread`, NSF player, recording, xdelta patcher,
  tape recorder, jstick — UI/host subsystems we don't drive.

468 built sources total (26 core + ~410 mappers + C audio + extra + 8 frontend
+ 2 C-reimpl). Compiles + links clean (~970 KB wasm) with `-D__unix__` and
`--allow-zero-length-arrays`; **no puNES source was patched** — the core builds
verbatim.

## One compiler.js change: attribute after a parameter declarator

puNES's core writes `f(int x __attribute__((unused)))`. The parameter parser
consumed the declarator but not a trailing `__attribute__`, so this was a hard
parse error. Fix: after a param declarator, consume a trailing
`parseGCCAttributes()` and ignore it (an attribute never affects the
parameter's ABI type). 6 lines, unit-suite-clean (708 pass). Regression test:
`tests/unit/conformance/pp_attr_param_declarator/` (clang-verified). This was
the *only* compiler gap the 104-KLOC core surfaced — the rest was pure
integration.

## Acceptance / test

Built-in NROM test ROM (no ROM arg): the hand-assembled 6502 waits out PPU
warm-up (two vblank polls — enabling rendering before warm-up is silently
dropped by the real 2C02, which puNES emulates), writes backdrop colour $21 into
palette RAM and enables rendering, so the PPU paints a solid frame. Same
solid-fill acceptance shape as `/bin/mgba`'s MODE 3 red. e2e:
`tests/kernel/test_punes_e2e.js` — window "puNES" 512×480, a `wmctl shot`, and a
pixel proof that the frame is the CPU-written palette-$21 blue (proves ROM load
+ mapper 0 + 6502 exec + PPU + palette + surface). Passes.

### Gotchas that cost time

- **Palette indexing off-by-my-arithmetic.** `nes_pal[0x21]` = {76,154,236} =
  `0x4c9aec`. I miscomputed it as `0x084cc4` and spent a long detour convinced
  the frame was a "host-default fill" when it was in fact the correct
  CPU-written backdrop all along. The frame worked from the first smoke test.
- **`--stale-ok` reuses the baked blob.** Iterating on `main.c` while testing
  with a pre-baked image (`--stale-ok`) runs the *stale* binary — every edit
  needs a fresh bake (drop `--stale-ok`, or `rm` the image). Several confusing
  "my change did nothing" results traced to this.
- Background *tile* rendering (a striped test ROM) didn't surface in the
  frame-stepped headless model — only the backdrop. Not chased: a uniform
  CPU-chosen backdrop is the same proof mgba's red-fill gives, and is the
  accepted bar. A patterned frame would be a nice-to-have follow-up.

Image bumped to v70 (`.nes` assoc + `/bin/punes` + Games menu entry).
