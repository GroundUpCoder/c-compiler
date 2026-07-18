# puNES D-pad ignored — SOCD filter clobbered treated[] from empty raw[] (todos/0213)

## Symptom
In puNES (the NES emulator, a gucman package), Z=A, X=B, Enter=Start,
Right Shift=Select all worked — but the four arrow keys / D-pad were silently
ignored in-game. DOOM and other SDL apps handle arrows fine, so it was puNES
wiring, not the OS input path.

## Root cause (already root-caused in the 0213 item)
Our bespoke puNES frontend (`vendor/punes/frontend/main.c`, "Replaces puNES's Qt
shell") drove the controller through `set_button()`, which poked
`port[0].data.treated[idx]` **directly**. The core's canonical entry point
`input_data_set_standard_controller()` sets BOTH `raw[]` and `treated[]`, and
`raw[]`/`treated[]` are separate arrays (not a union). So `raw[]` stayed 0.

On every $4016 controller read the core runs the SOCD (opposing-direction)
filter (`standard_controller.c` `input_updown_leftright_standard_controller`).
With `permit_updown_leftright == 0` (the memset-0 default, never set by our
frontend) it does NOT early-return for the four D-pad axes: it reads
`raw[axis]` (== 0) and writes it back into `treated[axis]`, erasing the D-pad on
every read. A/B/Select/Start are non-axis indices → they hit the filter's
`else { return; }` and survive. Exact fingerprint of the symptom.

## Fix (frontend-only, faithful — no core patch)
Route `set_button()` through the canonical API:

```c
static void set_button(int idx, int pressed) {
    input_data_set_standard_controller(idx, pressed ? PRESSED : RELEASED, &port[0]);
}
```

This populates `raw[]`, so the core's normal `raw[] → treated[]` SOCD mirror
produces correct state AND preserves SOCD filtering (same effect as poking
`raw[]` directly, but via the intended entry point upstream's input map always
uses). Added `#include "standard_controller.h"` for the declaration (it lives in
`src/core/input`, already on the bin.json include path; `input.h` doesn't pull
it in). Touched ONLY `vendor/punes/frontend/main.c`.

## Closing the coverage hole that let this ship
The puNES e2e (`tests/kernel/test_punes_e2e.js`) injected only ONE button (A) —
a non-axis index, the exact class that was NEVER broken — so it was blind to the
D-pad bug. The built-in NROM test ROM's NMI handler previously read only the A
bit. Extended it to read the shift register in standard order (A, B, Select,
Start, Up) and tint palette entry 0: **$2A green while Up is held**, else $30
white while A, else $21 blue. The e2e now injects A (→ white), releases (→ blue),
then Up (SDLK_UP = 1073741906 → green) and asserts each frame.

**Guard proven:** temporarily reverting `set_button()` to the direct-poke path
and re-running made the Up leg fail (frame stayed blue `4c9aec` instead of green
`4cd020`) while A / release / blue all still passed — reproducing the original
symptom exactly and confirming the new leg catches the regression.

## Gate
- puNES e2e: 12/12 PASS (was 8 checks; +4 for the release + D-pad legs).
- Projects suite: 26/26 (punes builds clean).
- Kernel suite: 90 pass; the one red (`test_gucman_quake_e2e`) is a known
  under-load timeout flake — passes standalone (21/21), unrelated to punes.
- compiler.js UNTOUCHED (vendor frontend + test only).

## Not done here (deferred to the coordinator)
No package rebake / deploy — that serializes behind the live storefront (#81)
work. The punes package payload changes with this frontend edit; the coordinator
sequences the `dist/packages` rebake + deploy. The other three emulators share
the one-button-only e2e gap (see the 4-emulator sweep item) — full-input
coverage for mgba/gameboy/sameboy is out of scope for 0213.
