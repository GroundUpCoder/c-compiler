# puNES — NES/Famicom emulator core (`/bin/punes`)

puNES (`punesemu/puNES`, aka FHorse) is a cycle-accurate NES/Famicom emulator
— accuracy tier, second only to Mesen on the standard test-ROM suites, with a
large mapper set and the 2A03 APU. Its **emulation core is plain C**; only the
Qt shell and a handful of exotic expansion-audio DSP files are C++. This is the
NES counterpart to `vendor/sameboy` (`/bin/sameboy`), ported per `todos/0088`.

- **Upstream**: https://github.com/punesemu/puNES
- **Pinned commit**: `2ed5b1b2cffcde48ff36f359091756d17d8fe193` (2025-12-31)
- **Core source is verbatim** from upstream `src/` (no patches — the compiler
  builds puNES's C as-is). Everything we add lives under `frontend/` and
  `shim/`; nothing in `src/core`, `src/audio`, `src/video`, `src/extra` was
  edited.

## Licensing — GPLv3 quarantine

puNES is **GPLv2-or-later**; upstream `COPYING` is GPLv2. This directory (core +
our frontend glue) is **GPLv3** — see `LICENSE` — electing v3 for the combined
work (puNES's "or later" permits it). **The rest of the repo stays Apache-2.0**:
the compiler and OS never *link* puNES (they compile/host it), and the SDL3 impl
is a puNES-agnostic library puNES merely consumes. Discipline: puNES knowledge
flows only *into* `vendor/punes/` — no Apache-tree file `#include`s a puNES
header (grep-clean). The shipped `punes.wasm` is a GPLv3 combined work.

## Layout

- `src/` — upstream puNES tree, verbatim. Built subset (see `bin.json`
  `sources`): the 26 C files in `src/core/`, ~410 mapper C files in
  `src/core/mappers/`, `src/core/input/`, the C audio layer
  (`src/audio/*.c` — blip_buf + handler + channels/mono/panning/wave),
  `src/extra/` (miniz, emu2413), and two **plain-C reimplementations** of C++
  helpers the core links: `src/c++/crc/crc.c` (IEEE-802.3 CRC-32) and
  `src/c++/pic16c5x/pic16c5x.c` (a no-op stub for the MMC5-adjacent PIC).
- `frontend/` — our GPLv3 SDL3 frontend and the `gui_*`/`gfx_*`/`snd_*` seam
  that replaces puNES's Qt shell:
  - `main.c` — SDL3 entry point: hand-runs puNES's power-on sequence
    (`memmap_init` → `ppu_init` → `emu_turn_on`), one NES frame per host
    animation frame (`emu_frame`), reads the PPU's completed palette-index
    buffer (`nes[0].p.ppu_screen.last_completed_wr`) straight out and maps it
    through an RGB NES palette into the window surface, drains the APU ring into
    the SDL audio stream, and feeds the keyboard into controller port 0. With no
    ROM argument it builds a minimal NROM test ROM in-memory (solid backdrop
    fill — the headless pixel-test target, same shape as `/bin/mgba`).
  - `pn_gfx.c` — the `_gfx gfx` global + `gfx_*` seam reduced to book-keeping
    (window/scaler/shader machinery is unused; main.c reads the framebuffer).
  - `pn_snd.c` — the `snd_*` backend: drains blip_buf/handler into a ring
    main.c pushes to SDL audio.
  - `pn_config.c` — the `_config cfg` defaults the core reads.
  - `pn_seam.c` — the `gui_*`/`log_*` seam (OS utils real, cosmetic ones
    stubbed) + input plumbing.
  - `pn_orphan.c` — the global instances upstream defines only in the excluded
    `core/compilation_unit_orphan.h` (info/machine/debugger/…).
  - `pn_stubs.c` — app-level function stubs (settings/uncompress/dipswitch/
    thread helpers the core references but we don't drive).
  - `pn_dsp_stub.c` — no-op stubs for the five exotic expansion-audio DSP chips
    whose C++ files are excluded.
- `shim/` — replacement headers for the platform/Qt tree the core `#include`s:
  `qt.h` (the `_gui` structs + seam decls, C-safe subset of upstream's
  `gui/qt.h`), `os_jstick.h` (Linux input-event constants + `js_os_*` decls),
  `pthread.h` (single-threaded no-ops), `compiled.h`/`opengl.h`/`win.h`.

## Excluded from the build (v1)

- **C++ the compiler can't build**: `src/c++/` (xBRZ scaler, l7zip, the real
  crc/pic16c5x — reimplemented in C above) and the C++ expansion-audio DSP
  under `src/core/mappers/` (`upd7756`, `hc55516`, `butterworth`, `waveFile`
  and their `*_interface.cpp`). These back only exotic carts; the handful of
  mappers that need them are dropped.
- **C files we don't drive**: `main.c` (Qt entry), `emu_thread.c`, `nsf.c`/
  `nsfe.c` (NSF music player UI), `recording.c`, `patcher_xdelta3_wrap.c`,
  `tape_data_recorder.c`, `jstick.c`, `uncompress.c`/`unif.c` (zip/7z load —
  raw `.nes`/`.fds` only for v1).

## Build / run

`bin.json` compiles with `-D__unix__` and `--allow-zero-length-arrays`. Seeded
into the OS as `/bin/punes` (image.json `system`), Start-menu Games entry, and
the `.nes → /bin/punes` openwith association. `punes <rom.nes>` loads a ROM;
bare `punes` runs the built-in test ROM.

Acceptance test: `tests/kernel/test_punes_e2e.js`.
