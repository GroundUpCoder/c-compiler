# #625 — GCODE.md: the commonly-missing symbols agents actually die on

Ticket #625 is the follow-up #505's own dev log named: the corrected n=3-per-arm
measurement showed BOTH arms burning their 12-turn budget on the same four
symbol classes (`SDL_Log`, `SDLK_r`/`SDLK_R`, `sqrtf`/`fabsf`/`floorf`,
`snprintf`/`SDL_snprintf`). This lane adds a "commonly-missing symbols" section
to `os/gcode/GCODE.md` and pins every claim behaviorally in
`tests/host/test_gcode_orientation.js`.

## Every claim was verified by a REAL compile before it was written

All compiles ran through `COMMON.createCcDriver(CompilerJS, kfs)` over an
in-memory BlockFS — the same driver `/bin/cc` ships (this is also what the
host test's flag-surface check already uses). Results:

| program | result |
|---|---|
| `#include <math.h>` + `sqrtf`/`fabsf`/`floorf`/`sinf` | **exit 0** |
| `sqrtf` with NO include | exit 1, `Undeclared identifier 'sqrtf'` |
| `#include <SDL.h>` + `SDL_Log("x")` | exit 1, `Undeclared identifier 'SDL_Log'` |
| `SDLK_r` / `SDLK_R` | exit 1, undeclared (both spellings) |
| `e.key.key == 'r'` (char-literal compare) | **exit 0** |
| `SDL_SCANCODE_R == 21` | **exit 0** |
| `#include <stdio.h>` + `snprintf` | **exit 0** |
| `SDL_snprintf` | exit 1, undeclared |
| `__require_source("__math.c")` written directly + own decl | exit 0 (works, but unnecessary — see below) |

## The ticket's `__require_source("__math.c")` claim is MISLEADING — corrected

The ticket body (quoting an agent transcript) says libm "needs
`__require_source(\"__math.c\")`". That is false as a *user requirement*:
`compiler.js`'s `math.h` header text carries `__require_source("__math.c")`
itself (compiler.js ~line 24809, right under `#pragma once`), so
`#include <math.h>` alone declares AND links the whole libm surface —
verified by the exit-0 compile above. The agents that "discovered"
`__require_source` had simply not included `<math.h>`. The doc therefore says
"need `#include <math.h>` — the header links the implementation
automatically", not the transcript's incantation.

## The other ground truths

- **`SDL_Log`**: zero occurrences in `compiler.js` (positive control:
  `SDL_GetError` hits at 22019/26780, and compiles). `todos/SDL3.md:444`
  lists `SDL_Log` in its unimplemented-notes section. Replacement:
  `printf`/`fprintf(stderr, …)` — the tty gets a GUI app's stdio.
- **`SDLK_` letter keys**: the header's SDLK block (compiler.js ~21706) has
  named/special keys only — no `SDLK_a..z`/`A..Z`. `host.js`'s `keysym()`
  (~10343) delivers modifier-applied ASCII on `event.key.key` (`'r'` plain,
  `'R'` shifted — SDL3 semantics, pinned by
  `tests/browser/sdl-shifted-keysym-check.mjs`; do NOT document SDL2
  unshifted semantics). The full `SDL_SCANCODE_A..Z` table (A=4 … R=21 … Z=29)
  exists on `event.key.scancode`. In-repo pattern: `os/pollball.c:62`.
- **`snprintf`**: declared in `stdio.h` (compiler.js ~25319), implemented at
  ~31556; `stdio.h` carries `__require_source("__stdio.c")`. `SDL_snprintf`
  does not exist anywhere.
- `sinf`/`cosf`/`atan2f`/`fmodf` verified present (24880-24904) before
  naming `sinf` in the doc's "…" list.

## Test additions (`tests/host/test_gcode_orientation.js`, section 6)

A shared cc harness (one in-memory BlockFS + driver, fresh source file per
compile) backs five new checks:

1. libm trio + sinf compile with only `<math.h>` — this is also the drift
   pin on math.h's own `__require_source`: remove it and the check goes red
   at link.
2. the four absent symbols each fail with the exact
   `Undeclared identifier '<sym>'` text.
3. the documented replacements compile (char-literal key compare,
   `SDL_SCANCODE_R == 21`, `snprintf`).
4. RED control: `SDL_GetError` (present) compiles — proves the absence
   checker discriminates, i.e. "fails to compile" is not vacuously true.
5. RED control: a bogus symbol fails — proves the exit-0 checks discriminate.

Doc-side red control (run, not committed): mutating GCODE.md's claims
(`do NOT exist` → `are fine`, dropping `#include <math.h>` and `snprintf`)
fails exactly the three new claim checks; restoring goes green. Checks 2/3
also assert the doc still carries each claim, so doc drift is a host-suite
red.

## No `os/image.json` bump

Image invalidation is content-addressed; no gate demanded a bump. Main's
version 249 is untouched.

## Gate

`node tests/run.js --diff origin/main --dry-run` → **host, kernel, sweep**
(GCODE.md is a baked docs-shaped input per #622; the test edit selects host).
Results in the lane report.
