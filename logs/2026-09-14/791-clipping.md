# #791 — shared rectangular clipping checkpoint

Author base: 16cb5333e97ce3425600b78e0b16eb38864ae16e, isolated branch
`author/791-render-font`. Shared drawing/fonts carry editor and tool UIs used
for game development inside gucOS. This checkpoint implements clipping first;
process-local font binding and the performance acceptance remain in #791.

SDL_SetRenderClipRect, SDL_GetRenderClipRect and SDL_RenderClipEnabled expose
per-target state. The current renderer uses target pixels (no viewport/scale API).
NULL or negative extents disable clipping, zero extents enable an empty clip.
Clear ignores clipping. SDL3 contract sources:
https://wiki.libsdl.org/SDL3/SDL_SetRenderClipRect and
https://wiki.libsdl.org/SDL3/SDL_SetRenderTarget; negative-extents behavior was
also inspected in upstream SDL_render.c SetRenderClipRectFloat on 2026-09-14.

The software rasterizer bounds both scanline and triangle traversal without
changing UVs or barycentrics. GPU draws capture immutable clip snapshots and
apply attachment-bounded scissors when submitted. Clip changes do not submit a
frame or rewrite already queued draws. Target and renderer resource records own
state; no kernel/window/input/lifecycle changes. Generated API index retires the
old clipping absence assertion in the same change.

Executed focused checks: clip facade unit 1/1; software surface SAB pixel test
(quad UVs, geometry interpolation, empty/offscreen/extreme clips); SDL API index
checks. The software test initially used incorrect exported layout key names;
that test-only error was corrected against WM_SAB_LAYOUT and rerun successfully.
These are not browser or graphical gucOS acceptance. The committed browser
fixture compiles in gucOS and runs both software and WebGPU processes, collecting
versioned screenshots and file hashes. It has not been executed at this commit.
Heavy window requested via #791 comments; coordinator owns integration/release
gates. `tests/run.js --diff 16cb5333 --dry-run` maps 25 suites (compiler.js);
no broad gate executed. Independent review, browser acceptance, cold/warm CPU/GPU
percentile measurements, and Small font consumer remain outstanding under #791.
