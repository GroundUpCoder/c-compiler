# #468 — SDL_ttf classic API as a builtin veneer over FreeType

The last unfiled SDL satellite library lands: `#include <SDL3_ttf/SDL_ttf.h>`
gives games real text — `TTF_OpenFont` on the baked Noto faces,
`TTF_RenderText_{Solid,Shaded,Blended}` (+ `_Wrapped`, `TTF_RenderGlyph_*`)
returning `SDL_Surface`s that `SDL_CreateTextureFromSurface` already consumes,
`TTF_GetStringSize`/`TTF_MeasureString`, metrics, style/hinting/kerning.
Gamedev justification (measured, twice): #487 Pong/Breakout and #508 Asteroids
each hand-rolled a bitmap font for their HUD, and the Asteroids font shipped
with a bit-order bug that mirrored every glyph — the gap manufactures a bug
class, not just friction.

## Shape — mirror the SDL_image contract, consume #464

Two compiler.js blocks, exactly the `SDL3_image/SDL_image.h` pattern:

- **`SDL3_ttf/SDL_ttf.h`** in `standardHeaders` — carries
  `__require_source("__SDL_ttf.c")`. Baked to `/usr/include` by the #439
  stdlib-header fold like every builtin.
- **`__SDL_ttf.c`** in `_stdlibSources` — reaches FreeType through
  `#include <ft2build.h>`, whose own require block (the #464 freetype srclib
  package) is the entire link story. So only programs whose include closure
  reaches `SDL_ttf.h` pull FreeType, a plain `<SDL.h>` program stays
  FreeType-free (measured: it compiles in a freetype-less fs), and a TTF
  program without the freetype package fails loud naming `ft2build.h`.
- `SDL_Color` (stock SDL3, `Uint8` rgba) joined SDL.h — the render calls take
  it by value, exactly as upstream spells them.

No new linking mechanism was invented; #464's seam carried everything.

## Dialect decision — SDL3_ttf 3.x spelling, not the ticket's SDL2 names

The ticket's scope list mixes SDL2_ttf-era names (`TTF_RenderUTF8_*`,
`TTF_SizeUTF8`) with SDL3 ones (`TTF_OpenFontIO`, `TTF_GetStringSize`). This
platform is a documented subset of SDL3 spelled like SDL3, and the header path
the ticket itself names (`SDL3_ttf/SDL_ttf.h`) is SDL3_ttf's. Under
PRINCIPLES ("never approximately implement a standard name" — mixing two
standards under one header is exactly that), the surface is the CLASSIC half
of SDL3_ttf 3.x, with every prototype verified against upstream
release-3.2.x's header (fetched during implementation, not recalled):
`TTF_RenderText_Blended(font, text, length, fg)` with `length` in bytes and
0 = null-terminated, etc. `TTF_RenderUTF8_*` does not exist here, the same
way it does not exist in real SDL3_ttf. One deliberate exception:
`TTF_GetError` (== `SDL_GetError`) is kept although upstream SDL3_ttf dropped
it — the ticket names it explicitly and the repo's own `IMG_GetError`
precedent already does the identical thing.

## Declared divergences (honest-shape accounting)

- **Every renderer returns RGBA32.** This platform has no palettized
  surfaces (every surface is RGBA32 platform-wide), so upstream's "8-bit
  palettized" Solid/Shaded storage format is not reproducible. The VISUAL
  semantics are preserved — Solid = bilevel ink on a transparent background,
  Shaded = antialiased on an opaque bg-colored box, Blended = antialiased
  per-pixel alpha — and the divergence is declared in the header, the impl,
  and the API index note.
- **Solid's bilevel raster is 50%-coverage-thresholded smooth output**, not
  FreeType's mono rasterizer: the #464 freetype module set ships `smooth`
  only (no `ftraster`), and `FT_RENDER_MODE_MONO` fails against it —
  measured live, the first e2e run went 79/82 with exactly the three Solid
  legs red. Widening the freetype package's module set is #464 surface, not
  this ticket's; the thresholded output keeps the documented observable
  (bilevel pixels, transparent bg) exactly.
- **fg.a == 0 is treated as opaque** — upstream's own quirk, pinned from its
  source and covered by a test leg.

## Left UNDECLARED (absence is honest; all fail loud as undeclared)

- `TTF_Text` / `TTF_TextEngine` everything — ticket #527, hard-blocked on
  this one. Not built, not half-built.
- `TTF_RenderText_LCD*` and `TTF_HINTING_LIGHT_SUBPIXEL` — no subpixel
  output path on this platform.
- `TTF_OpenFontIO` / `TTF_OpenFontWithProperties` — `SDL_IOStream` and
  `SDL_Properties` do not exist on this platform; the parameter types are
  undeclarable.
- `TTF_SetFontOutline` — needs FT_Stroker, not in the module set.
- Fallback-font chains, SDF, `TTF_SetFontDirection`/script/language (no
  HarfBuzz — kerning is the `kern` table via `FT_Get_Kerning`, so GPOS-only
  faces like the baked Notos report no pairs, same as upstream without
  HarfBuzz), `TTF_SetFontWrapAlignment` (wrapped lines are left-aligned).
  These are candidate follow-ons, surfaced in the lane report rather than
  silently cut: fallback chains and wrap alignment are the two that could be
  implemented honestly if a game needs them.

The `mksdlindex.js` ABSENT list now pins the modern-API absences BY NAME
(with `see` anchors into the classic surface), the `TTF_` half of the
family sweep retired (the `Mix_` half stands), and the index gained the
SDL_ttf section — sub-header `#define`s (TTF_STYLE_*) now emit into the doc,
a generator gap this surfaced.

## Two-sided edits (PRINCIPLES: filling an absence)

- `tools/mksdlindex.js` ABSENT entry rewritten (was: "no TTF_* function
  exists"), family sweep narrowed, doc regenerated (`--check` green).
- `tests/host/test_sdl_api_index.js` behavioral absent list: `TTF_OpenFont`
  → `Mix_OpenAudio`.
- `os/doc/sdl-gucos.md` "Text: there is no SDL_ttf" section rewritten to
  document the real surface + the render-once-cache-the-texture rule;
  `os/gcode/GCODE.md` parenthetical updated.
- `todos/SDL3.md` satellite-libraries note: SDL_ttf ✓ landed.

## Ticket scope 5 (a `packages/` entry) — resolved by the precedent

The veneer is builtin (header + impl live in compiler.js; fonts are baked);
there is no payload for an `sdl-ttf` package to carry. The package layer
settled this shape with SDL_image: no `sdl-image` metapackage exists either —
the doc + index note say `gucman install <backend>` (`libpng` there,
`freetype` here), and the missing-backend compile error names the header to
fix. Mirroring that contract exactly was the kickoff's prime directive;
minting a first-ever empty metapackage would be a new shape.

## Tests

- `tests/kernel/test_sdlttf_e2e.js` — fat image, in-OS `cc ttfdemo.c` with
  no -I and no TU list; the C program is self-checking with 86 legs and the
  driver requires `fail=0` + a floor on the ok count. Pixel-level: ink
  count/bbox/color-exactness, AA-present vs bilevel vs opaque-box per mode,
  baseline positioning ("Hello" ink must sit between cap top and the
  baseline row), surface dims == `TTF_GetStringSize` dims, é-vs-e accent
  height (the not-Latin-1 control), invalid-UTF-8 predictability, wrap
  geometry in lineskip units, bold-adds-ink, a real full-width underline
  rule row, the DPI leg (12pt @ 144dpi ≈ 24pt @ 72dpi widths).
- `tests/host/test_sdlttf_link.js` — the freetype-less fs pair: plain SDL
  links (pay-for-what-you-use, the compile succeeding is the measurement),
  TTF fails loud naming `ft2build.h` and NOT as an undeclared TTF_* (which
  doubles as the header-declares-its-surface positive control).
- No golden `expected.stdout` exists to derive: the e2e's oracle is the
  upstream-pinned contract (signatures + semantics read from SDL_ttf
  release-3.2.x source during implementation) expressed as inequalities and
  invariants the program checks itself.

`os/image.json` 264 → 265 (baked headers + docs changed; the browser OPFS
gate only re-fetches on a version bump).
