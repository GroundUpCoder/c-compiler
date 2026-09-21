# SDL3 render targets absent — but SDL_TEXTUREACCESS_TARGET is defined in the shipped header

**Class: feature-gap (plus one honest-shape wart). Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

`SDL_SetRenderTarget`/`SDL_GetRenderTarget` do not exist anywhere (0 hits in `/usr/include/SDL.h`, compiler.js, host.js — positive-controlled against `SDL_RenderGeometry` which hits). Yet the shipped header **defines `SDL_TEXTUREACCESS_TARGET = 2`** in the `SDL_TextureAccess` enum (`compiler.js` header block, `/usr/include/SDL.h:110-114`): a name that advertises a capability with no API behind it. Per `todos/PRINCIPLES.md` honest shape, either implement render targets or drop the enum member (absence is honest; a dangling constant is bait).

## Observed demand

The dogfood agent, asked for a pre-rendered spinning title ship, checked for render targets first (`grep RenderTarget /usr/include/SDL.h`), found none, and fell back to CPU-rasterizing a 24-cell sprite sheet into a buffer + one `SDL_UpdateTexture`. The fallback works, but offscreen render-to-texture is standard 2D-game vocabulary (pre-render, minimaps, post-effects, glow), and upstream SDL3's renderer has it.

## Fix shape

Browser WebGPU tier: render into a texture-backed target instead of the swapchain (the batching path is target-agnostic). Software tier: trivially a second framebuffer once the tier has a real rasterizer (blocked-by relationship with the RenderLine/Geometry P0 from this pass). If deferred, remove `SDL_TEXTUREACCESS_TARGET` and document the absence in `os/doc/sdl-gucos.md`.

## Gamedev justification

Direct SDL surface for games; hit live by the epic's own dogfood pass.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s5-frontier.log` ("No render targets — I'll build the sprite sheet on CPU").
