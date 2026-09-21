# SDL games have no text path — every dogfood game hand-rolls a bitmap font (and one hand-rolled font shipped mirrored)

**Class: feature-gap. Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

There is no way for an SDL game to draw text short of writing a font engine: no SDL_ttf veneer (0 hits for TTF in `/usr/include`), and freetype — though vendored, baked, and already serving ksvc/term/win32 — is not reachable as a game-friendly "render this string" call.

Measured consequence, two-for-two across the dogfood arm: round 1's Breakout (#488) hand-rolled a bitmap font for its HUD; round 2's Asteroids hand-rolled another 5×7 font — and that font shipped with a bit-order bug that mirrored every glyph, which the agent's self-verify then failed to catch (separate ticket). The absence is not just friction; it manufactures a bug class.

## Fix shape

`GAMEDEV-EPIC.md` already names the model: "SDL_ttf classic API without TTF_Text" — TTF_OpenFont/TTF_CloseFont/TTF_RenderText_* returning an SDL_Surface (SDL_CreateTextureFromSurface exists), over the vendored freetype the image already bakes fonts for (`/usr/share/fonts`). The triple filter (useful / expected / not too difficult) passes: freetype linkage via header-pull already works (`#include <ft2build.h>` pattern), and fontcore/ksvc are prior art for the raster loop.

## Gamedev justification

Score/lives/menus are in every game; the epic's "enjoyable" bar cannot include "first, write a font engine".

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/` — s1-brief.log ("No TTF — I'll draw text with a small bitmap font"), evidence/asteroids/asteroids.c FONT table, title_verify.png (the mirrored result).
