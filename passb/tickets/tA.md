# Software renderer: SDL_RenderLine draws a filled bbox for diagonals; SDL_RenderGeometry is a silent no-op

**Class: contract-violation (shipped feature). Found by #508 Pass B round 2 (dogfood-via-agent), observed at commit e704f078.**

## The defect

The software SDL renderer tier degrades two shipped, header-documented APIs to wrong pixels while returning success:

- `SDL_RenderLine` on any non-axis-aligned segment: the C veneer correctly emits a rotated 1px-thick quad (`compiler.js:28356`, `__sdl_render_quad` with 4 arbitrary corners), but the software tier's `__sdl_render_quad` collapses ANY quad to its **axis-aligned bounding box** (`host.js:7986-7990`: `minx/miny/maxx/maxy` → `quad(...)`). A 90×70 diagonal line rasterizes as a **6300-px filled rectangle**. `SDL_RenderLines` (#601, shipped 2026-08-13) inherits this per segment.
- `SDL_RenderGeometry` in the software tier is literally `__sdl_render_geometry: function () {}` (`host.js:7992`) — validates args, returns `true`, draws **nothing**.

The browser WebGPU tier implements both correctly (`host.js:9190+` batches arbitrary quads as two triangles; `host.js:9224+` copies the triangle soup). So the same program produces correct pixels in a browser tab and wrong pixels (a) headless under `os/boot.js` and (b) **in the browser under `SDL_RENDER_DRIVER=software`** — the exact mode `/usr/share/doc/sdl-gucos.md` tells classic-blocking-loop programs to use, and the mode the seeded minesweeper Desktop sample runs in.

## Why this is P0

- SDL3's contract for `SDL_RenderLine` is "draw a line"; drawing its filled bbox and returning success violates it. `SDL_RenderGeometry` returning success while drawing nothing is the "approximately implement a standard name" shape `todos/PRINCIPLES.md` forbids.
- It is **undocumented and untracked**: zero mentions across the open queue (verified 2026-08-13 against all open tickets), no `todos/LIABILITIES.md` entry, no caveat in `os/doc/sdl-gucos.md`. The only record is the host.js:7806-7809 comment ("degrade to a bbox / no-op — no sprite-blit game needs them (a noted follow-up)") — a true gap comment with no ticket, which is itself the LIABILITIES enrolment anti-pattern (todos/done/0286). **Fix should add the LIABILITIES entry or (better) the implementation.**
- The "no sprite-blit game needs them" premise is measured false: the first game an agent wrote in this dogfood pass (line-art Asteroids) hit both within minutes — the ship rendered as a solid bar; the agent had to rasterize all line art via Bresenham + `SDL_RenderPoints` (its workaround is in the evidence).

## Repro

Headless (`node os/boot.js`), any SDL app: `SDL_RenderLine(r, 100,100, 190,170)` then `wmctl shot` → filled 90×70 box, not a line. `SDL_RenderGeometry` with a 3-vertex triangle → nothing drawn, returns true.

## Fix shape (per PRINCIPLES: implement properly, or fail loud — never wrong pixels + success)

The software tier needs a real triangle rasterizer (then quads = 2 triangles, thin rotated quads = lines, and `__sdl_render_geometry` feeds the same path). This also unblocks software-tier `SDL_RenderTextureRotated`/render-targets follow-ons.

## Gamedev justification

Line art and rotated/textured geometry are core 2D game vocabulary; the epic's raised bar (jku 2026-08-09) requires the gcode-authored arm to work, and gcode verifies its games headless — i.e. exclusively through this broken tier.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/` (s1-brief.log research phase; s4-patience.log "broken line renderer" discovery; evidence/asteroids/asteroids.c workaround).
