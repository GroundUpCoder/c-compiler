# SDL3: SDL_RenderTextureRotated absent — rotating-sprite games need a sprite-sheet workaround

**Class: feature-gap. Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

`SDL_RenderTextureRotated` has no veneer implementation and no header declaration (0 hits across `/usr/include/SDL.h`, compiler.js, host.js; positive control: `SDL_RenderTexture` hits). It is the standard SDL3 rotated-blit and the first thing a game reaches for to draw a rotating ship/sprite.

## Observed demand

The dogfood agent, asked for a spinning title ship, grepped for it by name, found it absent, and pre-rendered a 24-orientation sprite sheet (15° steps) — workable, but quantized, memory-proportional-to-angular-resolution, and re-derived by every future game.

## Fix shape

The browser WebGPU tier already batches **arbitrary-corner quads** (`host.js:9190` `__sdl_render_quad` takes 4 free corners) — a rotated blit is just 4 rotated corners through the existing primitive plus the SDL3 center/flip argument handling in the C veneer; near-free there. The software tier degrades those same quads to bboxes today, so its half is blocked by the software-rasterizer P0 filed by this pass. Ship it honestly: either both tiers correct, or header-absent until then — never present-but-wrong.

## Gamedev justification

Rotation is core 2D game vocabulary (ships, turrets, debris); the epic's dogfood hit it on game #2.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s5-frontier.log` ("No SDL_RenderTextureRotated in this subset — so the spin will be a pre-rendered sprite sheet").
