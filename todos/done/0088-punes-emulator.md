# 0088 — puNES: a cycle-accurate NES/Famicom core (`/bin/punes`)

- **Status**: DONE (2026-07-12). puNES @ `2ed5b1b` vendored at `vendor/punes/`
  (GPLv3, core verbatim — no patches); seeded as `/bin/punes`, Games-menu entry,
  `.nes → /bin/punes` openwith default; image v70. Frontend is fresh SDL3 glue
  (not the recovered pre-Qt frontend) — the `gui_*`/`gfx_*`/`snd_*` seam under
  `frontend/` + C-safe `shim/` headers; C++ (xBRZ/l7zip/crc/pic16c5x + exotic
  expansion-audio DSP) excluded, crc/pic reimplemented in C. One compiler.js
  fix (attribute after a parameter declarator; regression test
  `tests/unit/conformance/pp_attr_param_declarator/`). Acceptance:
  `tests/kernel/test_punes_e2e.js` (window 512×480 + solid-frame pixel proof).
  Dev log `logs/2026-07-12/0088-punes-nes-core.md`; port notes
  `vendor/punes/README.md`. No follow-up items owed (patterned-frame test ROM
  and expansion-audio carts noted as nice-to-haves in the dev log, not queued).
- **Design**: this file. NES counterpart to `0075` (SameBoy, done →
  `/bin/sameboy`). Same shape: vendor a real-world C emulator core, write a
  thin SDL3 frontend, seed it into the image. `0072`'s openwith map can later
  route `.nes` → `/bin/punes`.

## Goal

Add **puNES** (`punesemu/puNES`, aka FHorse) as an NES/Famicom emulator at
`/bin/punes`. Its **emulation core is C** (~104 KLOC of `.c`/`.h` in
`src/core/`), and unlike fixNES it's in the *accuracy tier*: cycle-accurate
CPU/PPU/APU, **second only to Mesen** on the standard test-ROM suites (fixNES
ranked well below), a huge mapper set, FDS disk games, NSF music, and the full
expansion-audio chips (VRC6/VRC7, Namco 163, Sunsoft 5B, MMC5). Actively
maintained (2026); fixNES has been frozen since 2020.

### Why puNES, not fixNES (supersedes the original pick, 2026-07-10)

0088 originally targeted fixNES on the premise that "the accuracy tier
(Mesen/ares/Nestopia) is C++ and out of scope, so fixNES is the best *C*
option." That premise was wrong on one count: **puNES's core is also C**, and
it *is* the accuracy tier — so we get Mesen-adjacent accuracy without leaving
C. The costs of the switch are real and tracked below: puNES is ~10× the code,
carries a **GPL** obligation fixNES's plan glossed over, ships a **C++ shell
plus a few C++ core files** we must exclude, and — unlike fixNES — **has not
yet been proven to compile through `compiler.js`**.

## Licensing — GPL quarantine (NEW; SameBoy was MIT, this isn't)

puNES is **GPLv2-or-later**. SameBoy (0075) was MIT, so `vendor/sameboy/`
raised no license question; puNES does. Plan:

- `vendor/punes/` holds the puNES core **and** our emulator-specific glue (the
  frontend that wires puNES's `gui_*` seam to SDL3, ROM loading, the
  frame/audio pump). This directory is **GPLv3** — its own `LICENSE`/`README`
  say so. Elect v3 for the combination (Apache-2.0 is GPLv2-incompatible but
  GPLv3-compatible; puNES's "or later" lets us).
- **The rest of the repo stays Apache-2.0.** This holds by dependency
  topology, not by the folder itself:
  - the compiler and OS never *link* puNES — they compile/host it, so they're
    categorically uninvolved (compiling GPL source doesn't taint a compiler);
  - our **SDL3 impl is a general library puNES consumes** — a GPL program
    calling it does not relicense it; it stays Apache and reusable.
- Discipline that keeps it airtight: **puNES knowledge only flows *into*
  `vendor/punes/`.** Keep the SDL3 impl puNES-agnostic; put anything that only
  exists because puNES needs it inside `vendor/punes/`. Nothing in the Apache
  tree may `#include` a puNES header. The shipped `punes.wasm` is a GPLv3
  combined work (offer its source); the compiler / OS / SDL3 impl remain
  separately Apache.

## Compile probe — NOT yet done (the fixNES probe does not transfer)

The old fixNES probe (ran `compiler.js` over the 9.9 KLOC core → **zero
blockers**, no compiler changes) is **void**: different, 10×-larger codebase.
puNES has **not** been run through `compiler.js` yet. Known structure to deal
with before/while probing:

- **C++ our C compiler can't build — must exclude:** vendored `src/c++/`
  (xBRZ scaler, l7zip, crc, pic16c5x) and the C++ DSP files under
  `src/core/mappers/` (`upd7756`, `hc55516`, `butterworth`, `waveFile`, and
  their `*_interface.cpp`). These back only exotic expansion-audio carts — drop
  them and the handful of mappers that need them for v1.
- **Decompression:** the core uses `miniz.h` (C — fine); zip/7z via
  `src/c++/l7zip` is C++ (drop — load raw `.nes`/`.fds`/`.nsf` for v1, the same
  call we made for fixNES's `unzip/`).
- Everything else in `src/core/` is C, but at 104 KLOC it *will* likely surface
  parse/codegen gaps (fixNES didn't). **First task is the probe**; file any
  blockers as compiler work.

## Plan

Mirror `vendor/sameboy/` and the Peanut-GB port, adjusted for size + GPL.

- **Vendor layout**: `vendor/punes/` with `bin.json`, `src/main.c` (our SDL3
  frontend), `targets/*.json` for ROMs. `sources` = `src/core/**.c` minus the
  C++ files and the Qt `gui/` tree.
- **Frontend seam**: the core calls back into the shell through **~30 `gui_*`
  functions**, all funneled through `src/core/gui.h` (which just does
  `#include "gui/qt.h"`). Replace that with our SDL3 frontend:
  - **Recover puNES's dropped SDL frontend from git history as scaffold** — it
    predates the Qt port (ChangeLog: "Dropped out dependencies from SDL and QT4
    libraries"), so the core once spoke exactly this seam; porting it beats
    re-deriving the globals by hand.
  - Most `gui_*` calls are cosmetic (OSD overlay, menu/widget updates) → stub.
    A handful are real OS utils (`gui_get_ms`, `gui_sleep`,
    `gui_hardware_concurrency`, temp/data folders, utf path helpers) → ~50
    lines of portable C. Input (`gui_decode_all_input_events`) → SDL events.
  - Audio is already abstracted (`blip_buf` + a `handler` layer) → feed the SDL
    audio queue. Video is the PPU framebuffer → SDL texture (rides our WebGPU
    backend, like the other engines).
- **Image wiring**: install `/bin/punes`; Start-menu entry; openwith `.nes`
  → `/bin/punes`; keep it self-contained like `/bin/sameboy`.

## Acceptance

- **Probe first**: the `vendor/punes/` core (minus C++/Qt) compiles through
  `compiler.js`; any blockers filed as compiler todos.
- `vendor/punes/bin.json` links clean and runs an NROM/MMC1/MMC3 `.nes` to a
  recognizable frame, headless pixel-tested like the gameboy/sameboy legs of
  the browser sweep.
- `/bin/punes <rom>` launches from the desktop/fileman.
- APU audio out (at least the base 2A03 channels; expansion chips a bonus).
- `vendor/punes/LICENSE` (GPLv3) present; no Apache-tree file includes a puNES
  header (grep-clean).
- Dev-log entry in `logs/` capturing the frontend approach chosen (recovered
  SDL frontend vs. fresh glue), the excluded-C++ mapper list, and the
  zlib/decompress decision.
