# 0088 — fixNES: a full-featured NES/Famicom core (`/bin/fixnes`)

- **Status**: open
- **Design**: this file. NES counterpart to `0075` (SameBoy, done →
  `/bin/sameboy`). Same shape: vendor a real-world C emulator core, write a
  thin SDL2 frontend, seed it into the image. `0072`'s openwith map can later
  route `.nes` → `/bin/fixnes`.

## Goal

Add **fixNES** (`FIX94/fixNES`, generic C) as an NES/Famicom emulator at
`/bin/fixnes`. It's the best NES option in reach: the accuracy tier
(Mesen/ares/Nestopia) is C++ and out of scope, and among C emulators fixNES is
both the most portable *and* by far the most capable — **~130 mappers**, FDS
disk games, NSF music, and a real APU including the expansion-audio chips
(VRC6/VRC7, Namco 163, Sunsoft 5B, MMC5).

## Current state (found — compile probe, 2026-07-10)

Cloned the ~9.9 KLOC core and ran `compiler.js` over **every** `.c` (CPU, PPU,
APU, all ~60 `mapper/*.c`, every `audio_*.c` expansion chip). Result:
**zero parse or codegen blockers** — the entire core compiles as-is. Unlike
SameBoy (which needed `--allow-zero-length-arrays` + bswap/statement-expr
handling), fixNES needs **no compiler changes at all**.

The only non-link diagnostic across the whole tree:
- `unzip/unzip.c` / `unzip/ioapi_mem.c` want `zlib.h` — for zipped-ROM
  loading. zlib is already vendored (`vendor/zlib/src/zlib.h`); add it to
  `includes` + link `vendor/zlib`, or just drop the `unzip/` module (optional).

Everything else that surfaced was **link-stage undefined symbols**
(`nesPAL`, `emuSkipFrame`, `nesPause`, `audioUpdate`, …) — the driver globals
and I/O that live in the stock frontend (`main.c`, `audio.c`, `alhelpers.c`),
which use **freeglut + OpenAL** and get replaced by our frontend anyway.

## Plan

Mirror `vendor/sameboy/` and the Peanut-GB port.

- **Vendor layout**: `vendor/fixnes/` with `bin.json`, `src/main.c` (SDL2
  frontend), `targets/*.json` for ROMs. `sources` = all core `.c` (cpu, ppu,
  apu, mem, mapper, mapperList, input, vrc_irq, all `mapper/*.c`, all
  `audio_*.c`); **exclude** the stock `main.c` / `audio.c` / `alhelpers.c`.
- **zlib**: either add `vendor/zlib/src` to includes + link `vendor/zlib`, or
  omit `unzip/` and load only raw `.nes`/`.fds`/`.nsf` (simpler v1).
- **Frontend** (`src/main.c`): provide the globals/entry the core links
  against (`nesPAL`, `emuSkipFrame`, `nesPause`, the ppu framebuffer output,
  the `audioUpdate`/sample sink). Drive it: PPU framebuffer →
  `SDL_UpdateWindowSurface`; APU samples → `SDL_AudioStream`; controller from
  `SDL_PollEvent`. **fixNES also ships `libretro/libretro.c`** — a ready-made
  clean frontend boundary; consider driving through the libretro core API
  instead of re-deriving `main.c`'s globals (likely less glue).
- **Image wiring**: install `/bin/fixnes`; Start-menu entry; keep it
  self-contained like `/bin/sameboy`.

## Acceptance

- `vendor/fixnes/bin.json` compiles + links clean through `compiler.js` and
  runs an NROM/MMC1/MMC3 `.nes` to a recognizable frame, headless pixel-tested
  like the gameboy/sameboy legs of the browser sweep.
- `/bin/fixnes <rom>` launches from the desktop/fileman.
- APU audio out (at least the base 2A03 channels; expansion chips a bonus).
- Dev-log entry in `logs/` capturing the frontend approach chosen
  (hand-rolled `main.c` globals vs. the shipped libretro core) and the zlib
  decision.
