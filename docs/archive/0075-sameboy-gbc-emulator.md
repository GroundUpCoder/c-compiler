# 0075 — SameBoy: a second, cycle-accurate GB/GBC core (`/bin/sameboy`)

- **Status**: done (2026-07-10) — SameBoy v1.0.3 Core vendored
  (`vendor/sameboy/`, pinned 208ba4a, subset minus debugger/cheats/rewind/
  save-state TUs), `/bin/sameboy` seeded + Start-menu entry (image v45);
  DMG via dmg_boot + CGB via cgb_boot (official v1.0.3 release binaries
  embedded as C arrays), Super Mario Deluxe reaches its title screen;
  `/bin/gameboy` unchanged and still the .gb/.gbc default (e2e-asserted).
  GB_SECTION intact via the PRE-EXISTING `--allow-zero-length-arrays`
  (wired through os-common.js buildProject); the one compiler fix spun out
  test-first as 0085 (multi-char char constants, done). Tests:
  `tests/kernel/test_sameboy_e2e.js` (15 checks, kernel suite).
  Follow-ups: 0086 (save states + core pickability), 0087 (GNU-extension
  gap triage: offsetof-ICE, statement exprs, elvis, embedded directives,
  constructors, vasprintf, bswap builtins).
- **Design**: this file. Sibling of `vendor/gameboy/` (Peanut-GB). Related:
  `0072` (openwith) already routes `.gb`/`.gbc` → `/bin/gameboy`; this adds a
  second core, it does **not** replace Peanut-GB.

## Goal

Add **SameBoy** (`LIJI32/SameBoy`, MIT) as a second Game Boy / Game Boy Color
emulator at `/bin/sameboy`, alongside — not replacing — the existing
`/bin/gameboy` (Peanut-GB). SameBoy is one of the most accurate open-source
GB/GBC cores (100% on blargg's tests, on par with Gambatte/BGB), so this buys
GBC accuracy Peanut-GB doesn't have, and it's **pure C** with a clean
core/frontend split — the same shape as the Peanut-GB port.

Keep Peanut-GB as the default (fast, tiny, proven). SameBoy is the
accuracy/GBC option.

## Current state (found — compile probe, 2026-07-10)

Shallow-cloned `SameBoy/Core/` (~22 KLOC pure C) and ran `compiler.js -a compile`
on the core files with the debugger/cheats/rewind/timekeeping `-D…` disables.
The 6502-analog CPU / PPU / APU / mapper logic is **not** the problem — it
parses. Three bounded, shimmable blockers, all in the plumbing:

1. **`GB_SECTION` central-struct macro** (`Core/save_state.h`). It wraps each
   field group of the giant `GB_gameboy_s` struct in
   `union __attribute__((aligned(8))) { uint8_t <n>_section_start; struct {…}; };`
   plus a `uint8_t <n>_section_end[0];` **zero-length array** marker (a GCC
   extension) used to compute save-state section offsets. The struct has ~11
   sections → ~11 `[0]` members. Our parser treats `[0]` as a **C99 flexible
   array member** and enforces *"only one flexible array member is allowed per
   struct"*. This is the load-bearing blocker (it also produces a misleading
   *"type specifier missing"* cascade at the `unsaved` section while the `[0]`
   markers are present).
2. **`__builtin_bswap16` / `__builtin_bswap32`** — 6+ uses (byte-swap for
   save-state endianness). Currently *"Undeclared identifier"*.
3. **GNU statement-expressions `({ … })` + `typeof`** — reached via SameBoy's
   `MIN`/`MAX` macros (`gb.c:515`). Currently *"Unexpected token: PUNCT '{'"*.

Evidence: with `GB_SECTION` redefined to plain `__VA_ARGS__` (drops the union +
`[0]` markers) and `unsaved` unwrapped, the whole struct parses and the errors
move into real code — exactly (1)-fallout, (2), (3) and nothing deeper.

## Plan

Prefer **shims over compiler changes** where clean (mirrors doom/quake), and
promote to a real compiler feature only where it pays off elsewhere too.

- **Vendor layout**: `vendor/sameboy/` with its own `bin.json` (mirror
  `vendor/gameboy/`), `src/main.c` SDL2 frontend, `targets/*.json` for ROMs.
  Compile the same way: `node compiler.js vendor/sameboy/bin.json -o sameboy.html`.
- **Blocker 1 — save-state sectioning**: build a **minimal core first** — no
  save states. Redefine `GB_SECTION` to inline fields
  (`#define GB_SECTION(name, ...) __VA_ARGS__`) via a project shim header and
  **exclude `save_state.c`** (and the `GB_SECTION_OFFSET/SIZE/GET` users) from
  `bin.json`. Sidesteps the `[0]` issue entirely. If save states are wanted
  later, the *right* fix is teaching the compiler GCC **zero-length arrays**
  (distinct from C99 flexible array members: multiple allowed, anywhere in the
  struct) — a small, generally-useful parser change; file as its own item.
- **Blocker 2 — bswap builtins**: force-include a shim providing
  `__builtin_bswap16/32` as `static inline` (or add them to the compiler's
  builtin set — cheap and broadly useful; likely the better home).
- **Blocker 3 — statement-expressions**: override `MIN`/`MAX` with plain
  ternary function-like macros via the shim header. If `({…})`/`typeof` show up
  outside these macros, consider real compiler support instead.
- **Frontend**: reuse the Peanut-GB `main.c` shape — SameBoy's core is
  callback-driven (`GB_set_pixels_output`, `GB_set_rgb_encode_callback`,
  `GB_set_vblank_callback`, `GB_set_sample_rate` + `GB_apu_*`, `GB_set_key_state`)
  → software framebuffer to `SDL_UpdateWindowSurface`, `GB_apu` samples to
  `SDL_AudioStream`, keys from `SDL_PollEvent`. GBC boot ROM handling per
  SameBoy docs (or run without a boot ROM initially).
- **Image wiring**: install as `/bin/sameboy`; leave `/bin/gameboy` as the
  default. `0072`'s `.gb`/`.gbc` association stays pointed at `/bin/gameboy`;
  optionally make the core pickable later.

## Acceptance

- `vendor/sameboy/bin.json` compiles clean through `compiler.js` (minimal core,
  no save states) and runs a GBC ROM (e.g. a GBC title) to a recognizable
  frame, headless pixel-tested like the gameboy leg of the browser sweep.
- `/bin/sameboy <rom>` launches from the desktop/fileman; `/bin/gameboy`
  unchanged and still default.
- Any compiler-side fixes (bswap builtins, and — if pursued — zero-length
  arrays / statement-expressions) land as their own todos with unit tests,
  not buried in the vendor port.
- Dev-log entry in `logs/` capturing the shim set and what was left to the
  compiler vs. the shim header.
