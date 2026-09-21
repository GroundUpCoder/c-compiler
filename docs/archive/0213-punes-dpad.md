# 0213 — puNES NES emulator: arrow keys / D-pad ignored (SOCD filter clobbers treated[] from empty raw[])

- **Status**: done
- **Design**: —

## Goal
Fix the puNES (NES) emulator ignoring the four arrow keys / D-pad. Z=A, X=B,
Enter=Start, Right Shift=Select all work — ONLY the four arrows fail. Other SDL
apps (DOOM) handle arrows fine. User-visible functional bug in a shipped app.

## Root cause (read-only investigation, 2026-07-16 — it's OUR wiring bug, not upstream, not the SDL shim)
Arrows ARE delivered correctly: browser ArrowRight -> os.html -> compositor.js
sdlWeb.keyMsg -> host.js keysym()=1073741903 (SDLK_RIGHT) -> kernel routes
unmodified -> puNES `switch(event.key.key)` matches. Right Shift (Select) takes
the identical scancode-masked path and works — proving arrows arrive.

Our puNES frontend is BESPOKE (header: "Replaces puNES's Qt shell"). Its
`set_button()` (vendor/punes/frontend/main.c:66) pokes `port[0].data.treated[]`
DIRECTLY, bypassing the core's canonical input entry point
`input_data_set_standard_controller()` (vendor/punes/src/core/input/standard_controller.c:126-131),
which sets BOTH `raw[]` AND `treated[]`. `raw[]` and `treated[]` are SEPARATE
arrays, not a union (vendor/punes/src/core/input.h:106-107), so `raw[]` stays 0.
On every $4016 controller read the SOCD (opposing-direction) filter runs
(standard_controller.c:38); with `permit_updown_leftright==0` (memset 0 in
`pn_config_defaults()`, pn_config.c, never set) it does NOT early-return for the
four D-pad axes — it reads `raw[axis]` (=0) and writes it back into
`treated[axis]`, erasing the D-pad every read (standard_controller.c:175,189-190,224-226).
A/B/Select/Start are non-axis indices -> hit `else { return; }`
(standard_controller.c:187) -> never clobbered. Exact fingerprint of the symptom.
Upstream never hits this because its input map always goes through
`input_data_set_standard_controller()`.

## Plan
Route `set_button()` (vendor/punes/frontend/main.c:65-67) through the canonical
API — `input_data_set_standard_controller(idx, pressed ? PRESSED : RELEASED, &port[0])`
— instead of poking the struct. This populates `raw[]`, so the core's normal
`raw[] -> treated[]` SOCD mirror produces correct treated state and preserves SOCD
filtering (the faithful fix; same effect as "write raw[] directly" but uses the
intended entry point). Frontend-only, no core patch.
Alt (simplest, less faithful): set `cfg->input.permit_updown_leftright = TRUE` in
`pn_config_defaults()` so the filter early-returns — side effect disables SOCD
(allows simultaneous Left+Right / Up+Down); harmless for an emulator.

## Acceptance
- puNES registers Up/Down/Left/Right in-game (D-pad moves).
- A/B/Start/Select still work (no regression).
- **Gate — the coverage hole that let this ship:** the puNES e2e currently injects
  only ONE button (A). Add an e2e leg that injects a D-pad DIRECTION and asserts
  the emulator registers it. (Same one-button-only gap applies to the other three
  emulators — see the 4-emulator bug sweep item; add full-input coverage there.)
