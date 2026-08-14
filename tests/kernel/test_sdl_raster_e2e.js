#!/usr/bin/env node
// Software-renderer triangle rasterizer e2e (#668): before this ticket the
// software SDL tier collapsed any rotated __sdl_render_quad to its axis-
// aligned BOUNDING BOX (an SDL_RenderLine diagonal drew a filled rectangle)
// and __sdl_render_geometry was a silent no-op (validated args, returned
// true, drew NOTHING) — wrong pixels reported as success, in the tier the
// docs recommend and every headless run uses. This pins the fix:
//
//   1. a diagonal RenderLine is a 1px line: on-line pixels drawn, the
//      immediate off-line neighbour and the bbox interior untouched
//      (RED CONTROL: pre-fix the bbox-interior probes are line-colored);
//   2. RenderGeometry draws a solid triangle: interior filled, in-bbox-but-
//      outside-triangle corner untouched (RED CONTROL: pre-fix the interior
//      probe is still the clear color — the silent no-op);
//   3. indexed + textured RenderGeometry samples the texture (NEAREST);
//   4. per-vertex colors interpolate (Gouraud);
//   5. untextured geometry honors the renderer draw-blend (BLEND arm).
//
// Headless the renderer always resolves to the SOFTWARE tier
// (makeSoftwareRenderer), which since #668 rasterizes rotated quads and
// geometry as real triangles under the GPU tier's pixel-center + top-left
// fill rule. Expected values are exact software-arm outputs (colors round
// to nearest at the write); blend probes carry small tolerances.
//
// Run: node tests/kernel/test_sdl_raster_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdlraster-');

/* ---- session A: build the scene app in-OS, run it, shot the surface ---- */
const scriptA = [
  "cat > /root/ras.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("rastest", 256, 192, 0);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    int fails = 0;',
  '    #define chk(name, expr) do { if (!(expr)) { fails++; printf("CHK-FAIL %s: %s\\n", name, SDL_GetError()); } } while (0)',
  '    SDL_SetRenderDrawColor(r, 20, 20, 20, 255);',
  '    SDL_RenderClear(r);',
  '    /* 1: diagonal line (16,16)->(80,80), red, NONE blend */',
  '    SDL_SetRenderDrawColor(r, 200, 0, 0, 255);',
  '    chk("RenderLine diagonal", SDL_RenderLine(r, 16, 16, 80, 80));',
  '    /* 2: solid green triangle via RenderGeometry (no indices) */',
  '    SDL_Vertex g[3] = {',
  '        { { 144, 16 }, { 0.0f, 0.8f, 0.0f, 1.0f }, { 0, 0 } },',
  '        { { 176, 80 }, { 0.0f, 0.8f, 0.0f, 1.0f }, { 0, 0 } },',
  '        { { 112, 80 }, { 0.0f, 0.8f, 0.0f, 1.0f }, { 0, 0 } } };',
  '    chk("RenderGeometry solid", SDL_RenderGeometry(r, NULL, g, 3, NULL, 0));',
  '    /* 3: indexed textured quad (2x1 NEAREST, blend NONE, white verts) */',
  '    unsigned char two[8] = { 0,0,200,255, 200,120,0,255 };',
  '    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 2, 1);',
  '    SDL_UpdateTexture(t, NULL, two, 8);',
  '    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(t, SDL_SCALEMODE_NEAREST);',
  '    SDL_Vertex q[4] = {',
  '        { { 16, 112 }, { 1, 1, 1, 1 }, { 0, 0 } },',
  '        { { 80, 112 }, { 1, 1, 1, 1 }, { 1, 0 } },',
  '        { { 80, 176 }, { 1, 1, 1, 1 }, { 1, 1 } },',
  '        { { 16, 176 }, { 1, 1, 1, 1 }, { 0, 1 } } };',
  '    int idx[6] = { 0, 1, 2, 0, 2, 3 };',
  '    chk("RenderGeometry indexed+textured", SDL_RenderGeometry(r, t, q, 4, idx, 6));',
  '    /* 4: Gouraud triangle: red / green / blue vertices */',
  '    SDL_Vertex gr[3] = {',
  '        { { 208, 16 }, { 1, 0, 0, 1 }, { 0, 0 } },',
  '        { { 240, 80 }, { 0, 1, 0, 1 }, { 0, 0 } },',
  '        { { 176, 80 }, { 0, 0, 1, 1 }, { 0, 0 } } };',
  '    chk("RenderGeometry gradient", SDL_RenderGeometry(r, NULL, gr, 3, NULL, 0));',
  '    /* 5: untextured geometry under the renderer BLEND arm (alpha 0.5) */',
  '    SDL_SetRenderDrawBlendMode(r, SDL_BLENDMODE_BLEND);',
  '    SDL_Vertex bl[3] = {',
  '        { { 144, 112 }, { 0.8f, 0.0f, 0.0f, 0.5f }, { 0, 0 } },',
  '        { { 176, 176 }, { 0.8f, 0.0f, 0.0f, 0.5f }, { 0, 0 } },',
  '        { { 112, 176 }, { 0.8f, 0.0f, 0.0f, 0.5f }, { 0, 0 } } };',
  '    chk("RenderGeometry blended", SDL_RenderGeometry(r, NULL, bl, 3, NULL, 0));',
  '    SDL_RenderPresent(r);',
  '    printf("RAS-UP fails=%d\\n", fails);',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/ras.c -o /root/ras && echo CC-OK',
  '/root/ras &',
  'wmctl wait win rastest 15000',
  'SID=$(wmctl list | grep "rastest$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/ras.png && echo shot-ok',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the raster app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));
check('app presented with every draw call succeeding (RAS-UP fails=0)',
  a.stdout.includes('RAS-UP fails=0'),
  (a.stdout.match(/(INIT|WIN|RDR|CHK)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));

/* ---- session B: extract the PNG shot and probe the scene ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/ras.png\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const buf = b.stdout;
  let shot = null;
  try { shot = parsePng(buf, 0); } catch (e) { /* short/garbled output */ }
  check('shot parses as PNG at client size 256x192',
    shot !== null && shot.w === 256 && shot.h === 192,
    shot ? shot.w + 'x' + shot.h : 'undecodable');
  if (shot) {
    const px = (x, y) => shot.px(x, y).slice(0, 3);
    const near = (p, r, g, bch, tol) =>
      Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - bch) <= tol;
    const probe = (name, x, y, r, g, bch, tol) =>
      check(name, near(px(x, y), r, g, bch, tol), `(${x},${y}) = ${px(x, y)} want ~(${r},${g},${bch})`);

    /* 1: the diagonal is a LINE, not its bbox */
    probe('diagonal line: on-line pixel drawn', 48, 48, 200, 0, 0, 0);
    probe('diagonal line: second on-line pixel drawn', 64, 64, 200, 0, 0, 0);
    probe('diagonal line: immediate off-line neighbour untouched (1px thin)', 50, 48, 20, 20, 20, 0);
    /* RED CONTROL pair: pre-#668 the bbox fill painted both of these red */
    probe('diagonal line: bbox interior above the line untouched', 72, 24, 20, 20, 20, 0);
    probe('diagonal line: bbox interior below the line untouched', 24, 72, 20, 20, 20, 0);

    /* 2: solid geometry triangle really draws (RED CONTROL: no-op pre-#668) */
    probe('solid triangle: interior filled', 144, 60, 0, 204, 0, 1);
    probe('solid triangle: in-bbox corner outside the triangle untouched', 118, 24, 20, 20, 20, 0);

    /* 3: indexed textured quad samples the texture */
    probe('textured geometry: left half is texel 0', 32, 144, 0, 0, 200, 0);
    probe('textured geometry: right half is texel 1', 64, 144, 200, 120, 0, 0);

    /* 4: Gouraud interpolation — near each vertex its color dominates */
    (function () {
      const p = px(208, 26);
      check('gradient triangle: red-dominant near the red vertex',
        p[0] > 180 && p[1] < 60 && p[2] < 60, `(208,26) = ${p}`);
      const q = px(232, 76);
      check('gradient triangle: green-dominant near the green vertex',
        q[1] > 160 && q[0] < 80 && q[2] < 40, `(232,76) = ${q}`);
    })();

    /* 5: untextured geometry under BLEND: src (204,0,0)@a=128 over (20,20,20)
       -> r = 204*128/255 + 20*127/255 = 112.3; g = b = 20*127/255 = 9.96 */
    probe('blended triangle: src-over on the clear', 144, 160, 112, 10, 10, 3);

    /* untouched clear region */
    probe('clear color intact outside every figure', 100, 100, 20, 20, 20, 0);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
