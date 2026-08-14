#!/usr/bin/env node
// SDL_RenderTextureRotated e2e (#672): before this ticket the standard SDL3
// rotated-blit had no header declaration and no veneer implementation (the
// #508 Pass B dogfood agent, asked for a spinning ship, fell back to a
// pre-rendered 24-orientation sprite sheet). #668's software-tier triangle
// rasterizer made both tiers honest for rotated quads, so the API can now
// ship correct rather than present-but-wrong. This pins the FULL contract:
//
//   A. angle=0 through the new entry point == SDL_RenderTexture semantics
//      (NULL srcrect, explicit dstrect);
//   B. angle=90 rotates CLOCKWISE about the default (NULL) center — the
//      2x1 texture's left texel lands in the TOP half (RED CONTROL: with
//      the angle dropped, or a counter-clockwise sign, the probe colors
//      swap or stay horizontal);
//   C. SDL_FLIP_HORIZONTAL mirrors left<->right;
//   D. SDL_FLIP_VERTICAL mirrors top<->bottom (1x2 texture);
//   E. HORIZONTAL|VERTICAL is a legal BITMASK combination — a 2x2 texture's
//      four distinct texels each land in the diagonally-opposite corner;
//   F. a non-default `center` really is the pivot: 180 degrees about the
//      dstrect's TOP-LEFT relocates the quad to the mirrored footprint and
//      leaves the original dstrect untouched (RED CONTROL: a quietly-dropped
//      center rotates in place — original footprint painted, new one empty);
//   G. an oblique 45-degree angle draws the diamond with rotated UV axes
//      (exercises the real degrees->radians trig path, not just the exact
//      90/180 corners);
//   H. NULL dstrect defaults to the texture's rect at the origin;
//   I. NULL renderer / destroyed texture fail with false + an SDL error.
//
// Headless the renderer resolves to the SOFTWARE tier, which since #668
// rasterizes rotated quads as real triangles; expected values are exact
// software-arm outputs (NEAREST sampling, NONE blend).
//
// Run: node tests/kernel/test_sdl_rotated_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdlrot-');

/* ---- session A: build the scene app in-OS, run it, shot the surface ---- */
const scriptA = [
  "cat > /root/rot.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("rottest", 320, 240, 0);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    int fails = 0;',
  '    #define chk(name, expr) do { if (!(expr)) { fails++; printf("CHK-FAIL %s: %s\\n", name, SDL_GetError()); } } while (0)',
  '    #define chkf(name, expr) do { if (expr) { fails++; printf("CHK-FAIL %s: expected false\\n", name); } } while (0)',
  '    SDL_SetRenderDrawColor(r, 20, 20, 20, 255);',
  '    SDL_RenderClear(r);',
  '    /* 2x1: left blue, right orange */',
  '    unsigned char two[8] = { 0,0,200,255, 200,120,0,255 };',
  '    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 2, 1);',
  '    SDL_UpdateTexture(t, NULL, two, 8);',
  '    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(t, SDL_SCALEMODE_NEAREST);',
  '    /* 1x2: top blue, bottom orange */',
  '    SDL_Texture *t2 = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 1, 2);',
  '    SDL_UpdateTexture(t2, NULL, two, 4);',
  '    SDL_SetTextureBlendMode(t2, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(t2, SDL_SCALEMODE_NEAREST);',
  '    /* 2x2: TL red, TR green, BL blue, BR white */',
  '    unsigned char four[16] = { 200,0,0,255, 0,200,0,255, 0,0,200,255, 200,200,200,255 };',
  '    SDL_Texture *t4 = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 2, 2);',
  '    SDL_UpdateTexture(t4, NULL, four, 8);',
  '    SDL_SetTextureBlendMode(t4, SDL_BLENDMODE_NONE);',
  '    SDL_SetTextureScaleMode(t4, SDL_SCALEMODE_NEAREST);',
  '    /* A: angle 0, no flip, NULL src, NULL center */',
  '    SDL_FRect dA = { 16, 16, 64, 64 };',
  '    chk("A angle0", SDL_RenderTextureRotated(r, t, NULL, &dA, 0.0, NULL, SDL_FLIP_NONE));',
  '    /* B: 90 degrees clockwise about the default center */',
  '    SDL_FRect dB = { 96, 16, 64, 64 };',
  '    chk("B rot90", SDL_RenderTextureRotated(r, t, NULL, &dB, 90.0, NULL, SDL_FLIP_NONE));',
  '    /* C: horizontal flip, no rotation */',
  '    SDL_FRect dC = { 176, 16, 64, 64 };',
  '    chk("C flipH", SDL_RenderTextureRotated(r, t, NULL, &dC, 0.0, NULL, SDL_FLIP_HORIZONTAL));',
  '    /* D: vertical flip, no rotation (1x2 texture) */',
  '    SDL_FRect dD = { 248, 16, 64, 64 };',
  '    chk("D flipV", SDL_RenderTextureRotated(r, t2, NULL, &dD, 0.0, NULL, SDL_FLIP_VERTICAL));',
  '    /* E: both flip bits (2x2 texture): every texel to the opposite corner */',
  '    SDL_FRect dE = { 16, 112, 64, 64 };',
  '    chk("E flipHV", SDL_RenderTextureRotated(r, t4, NULL, &dE, 0.0, NULL,',
  '        (SDL_FlipMode)(SDL_FLIP_HORIZONTAL | SDL_FLIP_VERTICAL)));',
  '    /* F: 180 degrees about an EXPLICIT center at the dstrect top-left:',
  '       the quad relocates to (224..256, 128..160); (256..288, 160..192)',
  '       stays clear */',
  '    SDL_FRect dF = { 256, 160, 32, 32 };',
  '    SDL_FPoint cF = { 0, 0 };',
  '    chk("F center", SDL_RenderTextureRotated(r, t, NULL, &dF, 180.0, &cF, SDL_FLIP_NONE));',
  '    /* G: oblique 45-degree diamond, default center */',
  '    SDL_FRect dG = { 112, 112, 64, 64 };',
  '    chk("G rot45", SDL_RenderTextureRotated(r, t, NULL, &dG, 45.0, NULL, SDL_FLIP_NONE));',
  '    /* H: NULL dstrect = texture rect at the origin (2x1 at 0,0) */',
  '    chk("H nulldst", SDL_RenderTextureRotated(r, t, NULL, NULL, 0.0, NULL, SDL_FLIP_NONE));',
  '    /* I: validation matches the SDL_RenderTexture discipline */',
  '    chkf("I null renderer", SDL_RenderTextureRotated(NULL, t, NULL, &dA, 0.0, NULL, SDL_FLIP_NONE));',
  '    SDL_Texture *dead = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 1, 1);',
  '    SDL_DestroyTexture(dead);',
  '    chkf("I dead texture", SDL_RenderTextureRotated(r, dead, NULL, &dA, 0.0, NULL, SDL_FLIP_NONE));',
  '    SDL_RenderPresent(r);',
  '    printf("ROT-UP fails=%d\\n", fails);',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/rot.c -o /root/rot && echo CC-OK',
  '/root/rot &',
  'wmctl wait win rottest 15000',
  'SID=$(wmctl list | grep "rottest$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/rot.png && echo shot-ok',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the rotated-blit app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));
check('app presented with every draw call succeeding (ROT-UP fails=0)',
  a.stdout.includes('ROT-UP fails=0'),
  (a.stdout.match(/(INIT|WIN|RDR|CHK)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));

/* ---- session B: extract the PNG shot and probe the scene ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/rot.png\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const buf = b.stdout;
  let shot = null;
  try { shot = parsePng(buf, 0); } catch (e) { /* short/garbled output */ }
  check('shot parses as PNG at client size 320x240',
    shot !== null && shot.w === 320 && shot.h === 240,
    shot ? shot.w + 'x' + shot.h : 'undecodable');
  if (shot) {
    const px = (x, y) => shot.px(x, y).slice(0, 3);
    const near = (p, r, g, bch, tol) =>
      Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - bch) <= tol;
    const probe = (name, x, y, r, g, bch, tol) =>
      check(name, near(px(x, y), r, g, bch, tol), `(${x},${y}) = ${px(x, y)} want ~(${r},${g},${bch})`);

    /* A: angle 0 == plain RenderTexture: left blue, right orange */
    probe('A angle0: left half is texel 0', 32, 48, 0, 0, 200, 0);
    probe('A angle0: right half is texel 1', 64, 48, 200, 120, 0, 0);

    /* B: 90 cw about the default center: blue TOP, orange BOTTOM.
       RED CONTROL: unrotated these probes sit on the left/right split
       (both columns same color per row); counter-clockwise swaps them. */
    probe('B rot90: top half is texel 0 (clockwise)', 128, 32, 0, 0, 200, 0);
    probe('B rot90: bottom half is texel 1', 128, 64, 200, 120, 0, 0);

    /* C: horizontal flip: orange LEFT, blue RIGHT */
    probe('C flipH: left half is texel 1', 192, 48, 200, 120, 0, 0);
    probe('C flipH: right half is texel 0', 224, 48, 0, 0, 200, 0);

    /* D: vertical flip of the 1x2: orange TOP, blue BOTTOM */
    probe('D flipV: top half is texel 1', 280, 32, 200, 120, 0, 0);
    probe('D flipV: bottom half is texel 0', 280, 64, 0, 0, 200, 0);

    /* E: H|V bitmask: each 2x2 texel lands in the opposite corner */
    probe('E flipHV: TL shows the BR texel (white)', 32, 128, 200, 200, 200, 0);
    probe('E flipHV: TR shows the BL texel (blue)', 64, 128, 0, 0, 200, 0);
    probe('E flipHV: BL shows the TR texel (green)', 32, 160, 0, 200, 0, 0);
    probe('E flipHV: BR shows the TL texel (red)', 64, 160, 200, 0, 0, 0);

    /* F: explicit top-left center, 180 degrees: quad relocated to
       (224..256, 128..160) with its content rotated 180 (u reversed);
       the ORIGINAL dstrect footprint stays clear.
       RED CONTROL: a dropped center rotates in place — the original
       footprint is painted and the relocated one is empty. */
    probe('F center: relocated quad near-pivot side is texel 0', 252, 144, 0, 0, 200, 0);
    probe('F center: relocated quad far side is texel 1', 228, 144, 200, 120, 0, 0);
    probe('F center: original dstrect footprint untouched', 280, 184, 20, 20, 20, 0);

    /* G: 45-degree diamond centered (144,144): texel 0 left of center,
       texel 1 right, bbox corner outside the diamond untouched */
    probe('G rot45: left of the diamond is texel 0', 120, 144, 0, 0, 200, 0);
    probe('G rot45: right of the diamond is texel 1', 168, 144, 200, 120, 0, 0);
    probe('G rot45: bbox corner outside the diamond untouched', 116, 116, 20, 20, 20, 0);

    /* H: NULL dstrect: the 2x1 texture at the origin */
    probe('H nulldst: (0,0) is texel 0', 0, 0, 0, 0, 200, 0);
    probe('H nulldst: (1,0) is texel 1', 1, 0, 200, 120, 0, 0);

    /* untouched clear region between the figures */
    probe('clear color intact outside every figure', 96, 96, 20, 20, 20, 0);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
