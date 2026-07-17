# SameBoy

Game Boy / Game Boy Color emulator using the [SameBoy](https://github.com/LIJI32/SameBoy)
core (MIT license, **v1.0.3**, commit 208ba4a) — the cycle-accurate
accuracy/GBC sibling of `vendor/gameboy` (Peanut-GB). Installed as
`/bin/sameboy` and, since it boots and runs better, the **default
`.gb`/`.gbc` handler** (todos/0075; 0072 store points here). Peanut-GB
(`/bin/gameboy`) remains installed as the lighter alternate core.

Since todos/0260 (menu-arch **M3**) the frontend (`src/main.c`, port glue
only — the core is untouched) is a **win32 app** on the uniform menu
facility: `RegisterClass`/`CreateWindowEx`/WndProc, GB buttons via
`WM_KEYDOWN/UP`, the framebuffer presented through GDI
(`SetDIBits`/`StretchBlt` ×3 into the client — the normal CPU bitmap
transport, *not* CS_OWNCLIENT), and a PeekMessage pump inside the
`__setAnimationFrameFunc` callback around the unchanged `GB_run_frame`
cadence. Menu: File ▸ Open ROM… (real comdlg32 `GetOpenFileNameW` into a
live ROM reload) / Quit; Emulation ▸ Pause / Reset / Auto Model / Force
DMG / Force CGB (`GB_switch_model_and_reset`); Options ▸ Palette ▸
Greyscale / DMG Green / MGB / GB Light (`GB_set_palette`) / Mute. Save
states are deliberately absent (save_state.c is not in this build).

The vendored subset is `Core/` only, minus the debugger, cheats, rewind and
save-state translation units (built with `GB_DISABLE_DEBUGGER/CHEATS/
CHEAT_SEARCH/REWIND/TIMEKEEPING`); the `GB_SECTION` save-state struct
sectioning is kept intact via the compiler's `--allow-zero-length-arrays`
(the sections' `[0]` end markers), so `GB_reset`'s section arithmetic is
byte-faithful and save states stay addable later. All sources compile with
`-DGB_INTERNAL` (this frontend tolerates the internal macros).

## Boot ROMs

SameBoy needs a boot ROM (no HLE skip — accuracy philosophy). `src/bootroms.c`
embeds SameBoy's own MIT boot ROMs, byte-for-byte from the official v1.0.3
release artifact `sameboy_winsdl_v1.0.3.zip`: `dmg_boot.bin` (256 B) and
`cgb_boot.bin` (2304 B). They are built from `BootROMs/*.asm` with rgbds,
which this repo does not vendor — re-extract from the release to update.

## Model selection

`--dmg` / `--cgb` force DMG-B / CGB-E; otherwise the ROM header's CGB flag
(0x143 bit 7) decides. The boot-ROM load callback maps every CGB/AGB request
(including `GB_BOOT_ROM_CGB_E`, the one CGB-E actually asks for) to the CGB
image, everything else to DMG. With no ROM argument a built-in test ROM
(same checkerboard program as vendor/gameboy's) runs on DMG-B.

## Controls

- Arrow keys = D-pad, Z = A, X = B, Enter = Start, Shift = Select
- Battery saves land next to the ROM as `<rom>.sav` on window close (and
  when Open ROM… swaps carts).

## Usage

Build standalone (uses built-in test ROM):

    node compiler.js vendor/sameboy/bin.json -a compile -o sameboy.html

Build with a ROM (shares vendor/gameboy/roms/, gitignored):

    node compiler.js vendor/sameboy/targets/supermario.json -a compile -o mario.html

In-OS: `sameboy /root/roms/SuperMarioDeluxe.gbc &` (kernel e2e:
`tests/kernel/test_sameboy_e2e.js`).

## Patches (all marked `PATCH(c-compiler)` in-source)

| File | Patch | Why |
| --- | --- | --- |
| `core/gb.h` | 4 `#ifndef GB_DISABLE_*` blocks removed inside `GB_SECTION(unsaved, …)` | directives embedded in macro arguments (UB that gcc/clang accept) — the removed members are always compiled out in this build anyway |
| `core/defs.h` | `MIN`/`MAX` → plain ternaries | no GNU statement expressions; every call site in the subset audited side-effect-free |
| `core/defs.h` | `GB_inline_const` → compound literal | same; value-identical for the lookup-table uses |
| `core/defs.h` | `__builtin_bswap16/32/64` as static inlines | builtins not provided by the compiler |
| `core/gb.c` | `#include <alloca.h>` | alloca is not in `<stdlib.h>` in this libc |
| `core/gb.c` | `vasprintf` → fixed 512-byte `vsnprintf` | no vasprintf in this libc |
| `core/gb.c` | rtc-section VLA → checked 128-byte buffer | `offsetof` doesn't fold to an integer constant expression yet |
| `core/printer.c` | image VLA → `static` max-size buffer | VLAs unsupported; 128 KB doesn't fit the 64 KB wasm stack, hence static (single-threaded world) |
| `core/display.c` | one statement expression unrolled | no `({…})` support |
| `core/apu.c` `core/random.c` | `__attribute__((constructor))` → lazy init | constructors unsupported; random.c seeds on first `GB_random` (explicit `GB_random_seed` still wins) |
| `core/apu.c` `core/display.c` `core/sgb.c` | `x ?: y` → `x ? x : y` (5 sites) | no GNU elvis operator; operands side-effect-free |

Multi-character char constants (`'GBS\x01'`, `'TPP1'`, …) needed no patch:
the compiler learned the GCC packing in todos/0085 (found by this port).
