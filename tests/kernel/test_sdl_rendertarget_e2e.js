#!/usr/bin/env node
// SDL render targets e2e (#496): SDL_SetRenderTarget / SDL_GetRenderTarget on
// the SOFTWARE renderer tier (headless the renderer resolves to
// makeSoftwareRenderer — no WebGPU device in Node; the GPU tier's twin is
// tests/browser/os-rendertarget.mjs). The discriminating shape: draw into a
// TARGET texture while the WINDOW is clear-blue, then composite the texture
// back — an implementation whose target silently draws to the screen instead
// paints the window before the blue clear erases it, so the probes go red both
// ways (target content missing AND stray paint absent).
//
// Contract legs (upstream SDL3 wiki, verified 2026-08-15):
//   - the texture must be created with SDL_TEXTUREACCESS_TARGET (STATIC refused)
//   - NULL restores the window; SDL_GetRenderTarget round-trips both ways
//   - SDL_RenderPresent while a target is bound FAILS (documented upstream)
//   - target content PERSISTS across unbind/re-bind (no implicit clear)
//   - target alpha is real: a transparent region of a target composites as
//     nothing (not black) when the target is drawn with BLEND
//   - drawing the bound target as its own source is refused loudly (upstream
//     leaves it undefined; this runtime names it)
//
// Pixel expectations are exact software-arm outputs (window clear (0,0,255)):
//   (16,16) blue clear   (40,40) green from bind #1   (72,40) yellow from
//   bind #2 (no clear — persistence)   (80,80) red target clear   (176,40)
//   (128,128,255) = semi-white target BLENDed over blue   (176,56) pure blue
//   (transparent target region paints nothing).
//
// Run: node tests/kernel/test_sdl_rendertarget_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdlrt-');

/* ---- session A: build the render-target app in-OS, run it, shot it ---- */
const scriptA = [
  "cat > /root/rt.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("rttest", 256, 128, 0);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '',
  '    /* -- contract: a bogus access value is refused at create -- */',
  '    if (!SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, (SDL_TextureAccess)7, 8, 8))',
  '        printf("ERR-ACC-OK\\n");',
  '    /* -- contract: a STATIC texture cannot become the target -- */',
  '    SDL_Texture *st = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 8, 8);',
  '    if (st && !SDL_SetRenderTarget(r, st) && strlen(SDL_GetError()) > 0)',
  '        printf("ERR-STATIC-OK\\n");',
  '',
  '    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, 64, 64);',
  '    if (!t) { printf("T-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    printf("T-OK\\n");',
  '',
  '    /* -- bind #1: clear red, green square top-left -- */',
  '    if (!SDL_SetRenderTarget(r, t)) { printf("BIND-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    if (SDL_GetRenderTarget(r) == t) printf("GRT1-OK\\n");',
  '    if (!SDL_RenderPresent(r) && strlen(SDL_GetError()) > 0) printf("PWB-OK\\n");',
  '    SDL_FRect self = { 0, 0, 8, 8 };',
  '    if (!SDL_RenderTexture(r, t, NULL, &self)) printf("SELF-OK\\n");',
  '    SDL_SetRenderDrawBlendMode(r, SDL_BLENDMODE_NONE);',
  '    SDL_SetRenderDrawColor(r, 255, 0, 0, 255);',
  '    SDL_RenderClear(r);',
  '    SDL_FRect g = { 0, 0, 32, 32 };',
  '    SDL_SetRenderDrawColor(r, 0, 255, 0, 255);',
  '    SDL_RenderFillRect(r, &g);',
  '    if (!SDL_SetRenderTarget(r, NULL)) { printf("UNBIND-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    if (SDL_GetRenderTarget(r) == NULL) printf("GRT0-OK\\n");',
  '',
  '    /* -- bind #2: NO clear — content must persist; add a yellow square -- */',
  '    SDL_SetRenderTarget(r, t);',
  '    SDL_FRect ye = { 32, 0, 32, 32 };',
  '    SDL_SetRenderDrawColor(r, 255, 255, 0, 255);',
  '    SDL_RenderFillRect(r, &ye);',
  '    SDL_SetRenderTarget(r, NULL);',
  '',
  '    /* -- alpha target: transparent clear + a semi-white top half -- */',
  '    SDL_Texture *t2 = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, 16, 16);',
  '    SDL_SetRenderTarget(r, t2);',
  '    SDL_SetRenderDrawColor(r, 0, 0, 0, 0);',
  '    SDL_RenderClear(r);',
  '    SDL_FRect top = { 0, 0, 16, 8 };',
  '    SDL_SetRenderDrawColor(r, 255, 255, 255, 128);',
  '    SDL_RenderFillRect(r, &top);',
  '    SDL_SetRenderTarget(r, NULL);',
  '',
  '    /* -- compose the scene on the window -- */',
  '    SDL_SetRenderDrawColor(r, 0, 0, 255, 255);',
  '    SDL_RenderClear(r);',
  '    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_NONE);',
  '    SDL_FRect d1 = { 32, 32, 64, 64 };',
  '    SDL_RenderTexture(r, t, NULL, &d1);',
  '    /* t2 keeps its default BLEND (RGBA32 alpha default) */',
  '    SDL_FRect d2 = { 160, 32, 32, 32 };',
  '    SDL_RenderTexture(r, t2, NULL, &d2);',
  '    SDL_RenderPresent(r);',
  '    printf("RT-UP\\n");',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/rt.c -o /root/rt && echo CC-OK',
  '/root/rt &',
  'wmctl wait win rttest 15000',
  'SID=$(wmctl list | grep "rttest$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/rt.png && echo shot-ok',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the render-target app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));
check('TARGET texture created', a.stdout.includes('T-OK'),
  (a.stdout.match(/T-FAIL[^\n]*/g) || []).join('; '));
check('bogus access value refused at create', a.stdout.includes('ERR-ACC-OK'));
check('STATIC texture refused as target with an error', a.stdout.includes('ERR-STATIC-OK'));
check('GetRenderTarget returns the bound texture', a.stdout.includes('GRT1-OK'));
check('RenderPresent while a target is bound fails with an error', a.stdout.includes('PWB-OK'));
check('drawing the bound target as its own source is refused', a.stdout.includes('SELF-OK'));
check('GetRenderTarget returns NULL after unbind', a.stdout.includes('GRT0-OK'));
check('app composed + presented (RT-UP)', a.stdout.includes('RT-UP'),
  (a.stdout.match(/(INIT|WIN|RDR|BIND|UNBIND)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));

/* ---- session B: extract the PNG shot and probe the composition ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/rt.png\n',
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

    probe('window clear is blue (target draws never leaked to the screen)', 16, 16, 0, 0, 255, 0);
    probe('bind #1 green square composited from the target', 40, 40, 0, 255, 0, 0);
    probe('bind #2 yellow square (content persisted across re-bind)', 72, 40, 255, 255, 0, 0);
    probe('target clear red composited', 80, 80, 255, 0, 0, 0);
    probe('semi-white target region BLENDs over blue', 176, 40, 128, 128, 255, 1);
    probe('transparent target region paints nothing', 176, 56, 0, 0, 255, 0);
  }
}

process.exit(failures ? 1 : 0);
