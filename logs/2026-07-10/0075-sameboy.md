# 0075 — SameBoy: a second, cycle-accurate GB/GBC core (`/bin/sameboy`)

SameBoy v1.0.3 (`Core/` only, pinned 208ba4a) now runs as `/bin/sameboy`
alongside Peanut-GB — `/bin/gameboy` stays the default `.gb`/`.gbc` handler
(0072 association untouched, asserted by the new e2e). Super Mario Bros.
Deluxe reaches its colorful title screen through SameBoy's real cgb_boot;
the built-in checkerboard test ROM (same program as vendor/gameboy's)
renders the exact `GB_PALETTE_GREY` shades through dmg_boot.

## What the compile probe predicted vs. what landed

The 0075 item predicted three blockers. Reality was kinder and meaner:

- **GB_SECTION `[0]` end markers** — no compiler work at all: the
  `--allow-zero-length-arrays` flag already existed (quickjs port). The
  section layout matches clang byte-for-byte (verified with an offsetof
  probe), so `GB_reset`'s section arithmetic is exact and save states stay
  addable later (0086). Wired the flag through `os-common.js`'s
  buildProject whitelist — the OS baker has its own compilerArgs switch,
  and quickjs isn't seeded, so the flag had never crossed it.
- **`__builtin_bswap*` / statement exprs / elvis / VLAs / constructors /
  vasprintf** — all shimmed or patched in the vendored copy, each marked
  `PATCH(c-compiler)` and tabled in `vendor/sameboy/README.md`. MIN/MAX
  double-evaluation audited across every call site in the subset (one
  `ftell` twice — idempotent). Full triage list filed as 0087.
- **The unpredicted one:** `GB_SECTION(unsaved, …)` embeds `#ifndef
  GB_DISABLE_*` blocks *inside the macro argument list* (UB that gcc/clang
  process). Our PP can't; since those features are always disabled in this
  build, the four blocks are deleted in the vendored gb.h — layout equals
  gcc's under the same flags.
- **0085 spun out and landed first:** multi-char char constants (`'SAME'`,
  `'GBS\x01'`, `'TPP1'`) evaluated to their first character, silently.
  GCC packing now implemented in the compiler (lexer + PP `#if`), so
  SameBoy's magic-number code needed zero patches.

## Boot ROMs

SameBoy has no boot-ROM-skip HLE (accuracy philosophy), and the boot ROMs
build from asm with rgbds, which we don't have. Solution: embed the
official v1.0.3 release binaries (`sameboy_winsdl_v1.0.3.zip` — SameBoy's
own MIT reimplementations, dmg 256 B + cgb 2304 B) as C arrays
(`src/bootroms.c`), provenance in the README. Embedding (vs. fs files)
keeps the standalone `sameboy.html` build working with no image wiring.

**The bug worth remembering:** the boot-ROM load callback's switch listed
`GB_BOOT_ROM_CGB_0/CGB/AGB_0/AGB` — but a CGB-E model requests
`GB_BOOT_ROM_CGB_E`, which fell into the DMG default. Symptom: a frozen
CGB frame whose two colors changed per run (uninitialized palette RAM
through the lazily-seeded `GB_random`) while DMG worked perfectly. The e2e
now asserts the CGB frame is colorful specifically to guard this mapping.

## Frontend notes

`src/main.c` mirrors the Peanut-GB frontend (same window geometry 480x432,
same keys, same catch-up frame loop) with SameBoy's callback API:
whole-frame pixels output + rgb_encode (RGBA32), per-sample APU callback
accumulated and pushed only when `SDL_GetAudioStreamQueued` is under
target (bounded memory headless — the 0017 discipline), battery saves to
`<rom>.sav` on quit. Model = `--dmg`/`--cgb` or header CGB flag; boot ROM
per requested type.

## Tests

- `tests/kernel/test_sameboy_e2e.js` (15 checks, in the kernel suite,
  IMG-tagged): window/title/geometry, DMG frame contains ONLY the four
  exact grey shades, animation between shots 2.5s apart, CGB leg (gated on
  the gitignored ROM like os_apps' HAVE_ROM) asserts ≥6 colors + non-grey,
  and the 0072 association still points at /bin/gameboy.
- Start-menu entry added ⇒ MENU_ENTRIES lists in test_wm_service_e2e.js
  and os-shell.mjs moved together (the documented triple-sync).
- Image version 44 → 45.

## Residue → owners

- 0086: save_state.c + optional core pickability (openwith recipe).
- 0087: GNU-extension gap triage (offsetof-as-ICE, statement exprs, elvis,
  embedded directives, constructors, vasprintf, bswap builtins).
