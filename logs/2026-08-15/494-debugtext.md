# #494 — SDL_RenderDebugText: a game can draw text now

Lane `lane/494` from `8a9d79e5`. The #487 dogfood pass had to hand-roll a 3x5
digit table to show a Pong score; this lands the API a developer actually
reaches for.

## Scope, as re-measured (not the ticket body)

The ticket's three-row table was stale: #468 landed the SDL_ttf classic API
and #464 made freetype linkable, so the live scope was exactly
`SDL_RenderDebugText` — still absent (grep = 0 in compiler.js AND host.js,
positive controls TTF_OpenFont = 5 / SDL_RenderTexture = 4 on the same
instrument) and still pinned by the ABSENT ledger row.

## The surface (upstream, re-derived from source)

From SDL release-3.2.x `src/render/SDL_render.c:5432-5575` +
`SDL_render_debug_font.h` — not the wiki alone:

- `bool SDL_RenderDebugText(renderer, float x, float y, const char *str)`
- `bool SDL_RenderDebugTextFormat(renderer, float x, float y, fmt, ...)`
- `#define SDL_DEBUG_TEXT_FONT_CHARACTER_SIZE 8`

Mechanism mirrored exactly: lazy per-renderer atlas of the 190 public-domain
8x8 glyphs (Marcel Sondaar / IBM VGA fonts; provenance comment kept), 14 per
row in 10px padded cells (140x140), white-on-transparent, tinted per call
from the current draw color via `SDL_SetTextureColorMod`/`AlphaMod`, one
`SDL_RenderTexture` per glyph, x advances 8. The `%s` fast path upstream has
in `RenderDebugTextFormat` is an optimization, not contract — ours formats
through libc `vsnprintf` (SDL and libc share one heap here).

**Faithful quirk, kept deliberately:** upstream maps raw codepoints >= 190 to
the "invalid" checkerboard glyph *before* its Latin-1 adjustment, so
U+00BE..U+00FF all render the checkerboard. The documented contract is
ASCII-only, so faithful-to-source beats a silent local improvement; the
header comment states the ASCII contract, and the e2e pins the quirk
behaviorally (U+00F7 renders the checkerboard, pixel-exact).

**No `SDL_SetRenderScale` interaction exists to carry**: that API is honestly
absent here (its own ledger row), so glyphs are always 8 window-pixels —
the veneer-wide draw-in-window-pixels-1:1 rule, stated at the declaration.

## Where it lives — compiler.js only, zero host changes

Everything flattens to the existing `__sdl_render_quad` import; both render
tiers already apply color/alpha mod in that path (host.js software rasterizer
+ WebGPU renderer), and the null tier's no-op mod stubs suffice (that tier
renders nothing by design). New `debug_atlas` field on `struct SDL_Renderer`;
`SDL_DestroyRenderer` reclaims it.

**Atlas construction — right conclusion, and the precise reason** (a first
draft of this argument was overbroad): upstream builds the atlas via
`SDL_CreateSurfaceFrom` -> `SDL_CreateTextureFromSurface`. Surfaces
*partially* exist in this veneer — TTF/IMG renderers return heap RGBA32
surfaces and `SDL_DestroySurface`/`SDL_CreateTextureFromSurface` are real —
but the surface **constructors** (`SDL_CreateSurface`, `SDL_CreateSurfaceFrom`)
are absent, so there is no way to wrap raw glyph bytes in an SDL_Surface.
`SDL_CreateTexture(RGBA32, STATIC)` + `SDL_UpdateTexture` is the honest
equivalent, landing the identical net texture state (RGBA32 => BLEND at
create, NEAREST set explicitly, as upstream).

UTF-8 stepping is a static twin of `ttf_step_utf8` (#468) — same
SDL_StepUTF8 rule, but `__SDL_ttf.c` is a different TU, so the SDL TU carries
its own copy. Invalid bytes -> U+FFFD -> the checkerboard: bad input renders
predictably.

## Two-sided ledger edit — the ABSENT row is DELETED, not re-pointed

The row's prose ("debug/HUD text is FreeType or a bitmap font") was about to
become actively wrong guidance — that is the real reason it goes, not just
staleness. No replacement pin is manufactured: the renderer-state row still
carries six genuinely-absent neighbors, and the compile-pin sampling list in
`test_sdl_api_index.js` never contained this symbol (the #468/#496
substitutions happened because those symbols WERE in that list). The test
grows the #494 positive inversion instead: both symbols + the size constant
must compile. The generator's deliberate-assignment guard fired on the new
constant exactly as designed — `SDL_DEBUG_TEXT_` got its own cluster with the
1:1-pixels note.

## image.json 266 -> 267 — the reason, not just the precedent

Version is the OPFS freshness key: `os/kernel-worker.js` gates
re-materialization of the persisted system blob on
`bakedVersion < manifest.version`, and the fetch is inside that guard — a
returning browser never re-fetches the baked `/usr/include/SDL.h` or
`/usr/share/doc/sdl-api-index.md` without a bump.

## Tests

- **Red control on base `8a9d79e5`**: the acceptance program fails in-OS cc
  with `Undeclared identifier 'SDL_RenderDebugText'` — the e2e's CC-OK leg
  catches exactly this.
- `tests/kernel/test_sdl_debugtext_e2e.js` (software tier, 28 checks, all
  pixel probes exact from the embedded font bitmaps): H/I counterforms and
  8px pen advance, format `%d`, space advances without ink, half-alpha white
  over pure blue lands exactly (128,128,255) (the #496 blend probe), the
  U+00F7 checkerboard quirk, debug text into a #496 render target composites
  where the target lands, one present = one kernel frame, NULL renderer/str
  refused. Registered in `tests/kernel/run.js` (untagged weight, the
  rendertarget row's class).
- `tests/browser/os-debugtext.mjs` (GPU tier, real Chromium, port 3453):
  same scene, same probes — PASS 19/19 first run. Sweep membership is
  glob-discovered; the evidence guard covers it.

## Noted, not touched

`todos/SDL3.md`'s renderer Missing list still names plural primitives and
`RenderTextureRotated` as missing — both landed (#601, #672). Only the
debug-text clause was mine to move; the stale neighbors are reported to
@master rather than silently swept into this diff.
