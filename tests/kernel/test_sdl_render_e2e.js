#!/usr/bin/env node
// SDL 2D renderer e2e (Minesweeper lane, review finding #3): the SDL_Render*
// choke — create renderer → RenderClear → blended fill quads + textured quads
// → present → `wmctl shot` pixel asserts. Headless the renderer resolves to
// the SOFTWARE tier (makeSoftwareRenderer — no WebGPU device in Node), so this
// pins the fallback's blend arms (NONE/BLEND/ADD/MOD, mirroring the GPU
// tier's SDL_BLEND_DESC pipelines) and both scale modes (NEAREST floor pick,
// LINEAR bilinear at texel-center+clamp — the GPU sampler's semantics).
//
// Expected values are the exact deterministic software-arm outputs over the
// (64,64,64) clear (u8 → f32/255 → f64*255 round-trips exactly):
//   NONE (200,30,40,128) → (200,30,40)      BLEND → (132,46,51)
//   ADD                  → (164,79,84)      MOD   → (50,7,10)
// Bilinear 2x1 [ (0,0,200) | (200,120,0) ] scaled ×32: probe at dst x=32 sits
// frac .5156 between texels → (103,61,96); NEAREST gives the hard edge.
//
// Run: node tests/kernel/test_sdl_render_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdlrender-');

/* ---- session A: build the scene app in-OS, run it, shot the surface ---- */
const scriptA = [
  "cat > /root/rdr.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("rdrtest", 256, 128, 0);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_SetRenderDrawColor(r, 64, 64, 64, 255);',
  '    SDL_RenderClear(r);',
  '    /* top row: one 64x64 fill per draw blend mode over the grey clear */',
  '    static const SDL_BlendMode modes[4] = {',
  '        SDL_BLENDMODE_NONE, SDL_BLENDMODE_BLEND, SDL_BLENDMODE_ADD, SDL_BLENDMODE_MOD };',
  '    for (int i = 0; i < 4; i++) {',
  '        SDL_FRect fr = { (float)(i * 64), 0.0f, 64.0f, 64.0f };',
  '        SDL_SetRenderDrawBlendMode(r, modes[i]);',
  '        SDL_SetRenderDrawColor(r, 200, 30, 40, 128);',
  '        SDL_RenderFillRect(r, &fr);',
  '    }',
  '    /* bottom row: scale modes (2x1 stretched wide) + texture blend modes */',
  '    unsigned char two[8] = { 0,0,200,255, 200,120,0,255 };',
  '    SDL_Texture *tL = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 2, 1);',
  '    SDL_UpdateTexture(tL, NULL, two, 8);',
  '    SDL_SetTextureBlendMode(tL, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(tL, SDL_SCALEMODE_LINEAR);',
  '    SDL_FRect dL = { 0.0f, 64.0f, 64.0f, 32.0f };',
  '    SDL_RenderTexture(r, tL, NULL, &dL);',
  '    SDL_Texture *tN = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 2, 1);',
  '    SDL_UpdateTexture(tN, NULL, two, 8);',
  '    SDL_SetTextureBlendMode(tN, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(tN, SDL_SCALEMODE_NEAREST);',
  '    SDL_FRect dN = { 64.0f, 64.0f, 64.0f, 32.0f };',
  '    SDL_RenderTexture(r, tN, NULL, &dN);',
  '    unsigned char one[4] = { 200, 30, 40, 128 };',
  '    SDL_Texture *tB = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 1, 1);',
  '    SDL_UpdateTexture(tB, NULL, one, 4);',
  '    SDL_SetTextureBlendMode(tB, SDL_BLENDMODE_BLEND);',
  '    SDL_FRect dB = { 128.0f, 64.0f, 64.0f, 32.0f };',
  '    SDL_RenderTexture(r, tB, NULL, &dB);',
  '    SDL_Texture *tA = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 1, 1);',
  '    SDL_UpdateTexture(tA, NULL, one, 4);',
  '    SDL_SetTextureBlendMode(tA, SDL_BLENDMODE_ADD);',
  '    SDL_FRect dA = { 192.0f, 64.0f, 64.0f, 32.0f };',
  '    SDL_RenderTexture(r, tA, NULL, &dA);',
  '    SDL_RenderPresent(r);',
  '    printf("RDR-UP\\n");',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/rdr.c -o /root/rdr && echo CC-OK',
  '/root/rdr &',
  'wmctl wait win rdrtest 15000',
  'SID=$(wmctl list | grep "rdrtest$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/rdr.png && echo shot-ok',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the renderer app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));
check('app created window + renderer + presented (RDR-UP)', a.stdout.includes('RDR-UP'),
  (a.stdout.match(/(INIT|WIN|RDR)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));

/* ---- session B: extract the PNG shot and probe the scene ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/rdr.png\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const buf = b.stdout;
  let shot = null;
  try { shot = parsePng(buf, 0); } catch (e) { /* short/garbled output */ }
  check('shot parses as PNG at client size 256x128',
    shot !== null && shot.w === 256 && shot.h === 128,
    shot ? shot.w + 'x' + shot.h : 'undecodable');
  if (shot) {
    const px = (x, y) => shot.px(x, y).slice(0, 3);
    const near = (p, r, g, bch, tol) =>
      Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - bch) <= tol;
    const probe = (name, x, y, r, g, bch, tol) =>
      check(name, near(px(x, y), r, g, bch, tol), `(${x},${y}) = ${px(x, y)} want ~(${r},${g},${bch})`);

    /* top row: the four draw blend modes */
    probe('fill NONE writes src opaque', 32, 32, 200, 30, 40, 0);
    probe('fill BLEND src-over on grey', 96, 32, 132, 46, 51, 2);
    probe('fill ADD accumulates onto grey', 160, 32, 164, 79, 84, 2);
    probe('fill MOD multiplies with grey', 224, 32, 50, 7, 10, 2);
    /* bottom row: scale modes + texture blend modes */
    probe('LINEAR clamps to texel 0 at left edge', 2, 80, 0, 0, 200, 2);
    probe('LINEAR interpolates between texels at midpoint', 32, 80, 103, 61, 96, 4);
    probe('NEAREST left half is texel 0 (hard edge)', 80, 80, 0, 0, 200, 0);
    probe('NEAREST right half is texel 1 (hard edge)', 112, 80, 200, 120, 0, 0);
    probe('texture BLEND src-over on grey', 160, 80, 132, 46, 51, 2);
    probe('texture ADD accumulates onto grey', 224, 80, 164, 79, 84, 2);
    /* untouched clear region below the rows */
    probe('clear color intact outside the quads', 32, 112, 64, 64, 64, 0);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
