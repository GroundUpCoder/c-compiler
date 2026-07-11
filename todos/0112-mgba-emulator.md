# 0112 — mGBA: a GBA (+GB/GBC) core (`/bin/mgba`)

- **Status**: open
- **Design**: this file. Third emulator leg, alongside `0075` (SameBoy, done →
  `/bin/sameboy`) and `0088` (puNES, open → `/bin/punes`). Same shape: vendor a
  real-world C emulator core, write a thin SDL3 frontend, seed it into the
  image. `0072`'s openwith map routes `.gba` → `/bin/mgba`.

## Goal

Add **mGBA** (`mgba-emu/mgba`) as a **Game Boy Advance** emulator at
`/bin/mgba`. Its emulation core is C (the `src/` core tree is C; only the Qt/SDL
*frontends* carry C++), MPL-2.0 licensed, and actively maintained (2026).

**This is additive — it does NOT replace Peanut-GB (`/bin/gameboy`) or SameBoy
(`/bin/sameboy`).** The point of mGBA is the platform those two can't touch:
**GBA**. mGBA also carries GB/GBC/SGB cores, but for plain GB/GBC SameBoy is the
more accurate choice and stays the default `.gb`/`.gbc` handler. mGBA's unique
value here is the ARM7TDMI/GBA leg; treat GB/GBC support in mGBA as a free
side-effect, not the reason to vendor it.

## Why mGBA (vs. the alternatives)

- **It's the only mature GBA option with a C core.** The accuracy-tier GBA
  emulators otherwise skew C++ (VBA-M, ares/higan). mGBA gives GBA coverage
  without leaving C — the same bet 0075/0088 made for GB and NES.
- **Permissive license.** MPL-2.0 — file-level copyleft, *not* viral like
  puNES's GPL. No repo-wide license quarantine of the 0088 kind is needed;
  MPL's obligations attach per-file to the mGBA sources we ship (keep the
  headers, offer modified-file source). Still confine everything mGBA-specific
  to `vendor/mgba/` for hygiene, but the Apache tree is not at risk the way it
  is with puNES.

## Licensing — MPL-2.0 (lighter than 0088's GPL)

- `vendor/mgba/` holds the mGBA core **and** our SDL3 glue. mGBA's own files
  stay MPL-2.0 (keep their headers); our new frontend files can be Apache-2.0
  or MPL — pick one and state it in `vendor/mgba/README.md`.
- **The rest of the repo stays Apache-2.0.** MPL is file-scoped, so unlike the
  GPL case there's no "combined work" relicensing of `mgba.wasm`; just preserve
  MPL notices on mGBA-derived files and publish any modifications to them.
- Same discipline as 0088 regardless: mGBA knowledge only flows *into*
  `vendor/mgba/`; keep the SDL3 impl mGBA-agnostic; nothing in the Apache tree
  `#include`s an mGBA header.

## Compile probe — NOT yet done

mGBA has **not** been run through `compiler.js`. It is a large, mature codebase;
expect the probe to surface parse/codegen gaps (as puNES is expected to, unlike
the tiny fixNES core). Known structure to deal with before/while probing:

- **Scope the core, exclude the frontends.** Vendor only the emulation core
  under `src/` (`src/arm/`, `src/gba/`, `src/gb/`, `src/core/`, `src/util/`);
  **exclude** `src/platform/qt/` (C++) and the SDL frontend app — we write our
  own SDL3 frontend. Trim optional subsystems (debugger, scripting/Lua, GDB
  stub, cheats, savestate-rewind) for v1, mirroring how 0075 built SameBoy with
  debugger/cheats/rewind disabled.
- **Build config.** mGBA is CMake-driven and generates a `version.c` +
  feature-flag headers at configure time; reproduce those as static vendored
  files (or a small `bin.json` codegen step) rather than depending on CMake.
- **Compression / deps.** mGBA can pull in zlib/libpng/minizip/SQLite for save
  archives, screenshots, and its game DB — **drop all of them for v1** (load
  raw `.gba`/`.gb`/`.gbc`, no PNG, no ROM database), same call 0088 made for
  decompression. Keep the dependency surface to core C only.

## Plan

Mirror `vendor/sameboy/` (0075) and the puNES port (0088), adjusted for size.

- **Vendor layout**: `vendor/mgba/` with `bin.json`, `src/main.c` (our SDL3
  frontend), `targets/*.json` for ROMs. `sources` = the core `src/**.c` subset
  minus the excluded frontends/optional subsystems above.
- **Frontend seam**: mGBA already separates core from platform via its
  `mCore` interface (`src/core/core.h`) — load ROM, run frame, expose the
  framebuffer + audio ring, feed input bits. Write our frontend against
  `mCore` directly rather than porting the Qt/SDL app:
  - Video: the core's framebuffer → SDL texture (rides our WebGPU backend, like
    the other engines).
  - Audio: mGBA's `blip_buf`-based mixer → SDL audio queue (same shape as the
    SameBoy/puNES audio legs).
  - Input: SDL events → GBA key bitmask via `mCore` key state.
  - BIOS: GBA runs without the official BIOS using mGBA's HLE BIOS — no
    boot-ROM embedding needed (unlike SameBoy's DMG/CGB boot ROMs).
- **Image wiring**: install `/bin/mgba`; Start-menu entry; openwith `.gba` →
  `/bin/mgba` (leave `.gb`/`.gbc` pointed at `/bin/sameboy`); keep it
  self-contained like `/bin/sameboy`.

## Acceptance

- **Probe first**: the `vendor/mgba/` core subset (minus C++/optional deps)
  compiles through `compiler.js`; any blockers filed as compiler todos.
- `vendor/mgba/bin.json` links clean and runs a simple commercial `.gba` to a
  recognizable frame, headless pixel-tested like the gameboy/sameboy legs of
  the browser sweep.
- `/bin/mgba <rom>` launches from the desktop/fileman; `.gba` opens it via
  openwith.
- APU audio out through the SDL audio queue.
- Peanut-GB (`/bin/gameboy`) and SameBoy (`/bin/sameboy`) are untouched;
  `.gb`/`.gbc` still default to SameBoy.
- MPL-2.0 notices preserved on all mGBA-derived files;
  `vendor/mgba/README.md` records the license split and the excluded
  subsystems; no Apache-tree file includes an mGBA header (grep-clean).
- Dev-log entry in `logs/` capturing the core-subset selection, the excluded
  frontends/deps, and the HLE-BIOS decision.
