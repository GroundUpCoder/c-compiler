#!/usr/bin/env node
// SDL_RenderDebugText e2e (#494): upstream SDL3's built-in 8x8 debug font on
// the SOFTWARE renderer tier (headless the renderer resolves to
// makeSoftwareRenderer; the GPU tier's twin is tests/browser/os-debugtext.mjs).
// The app is built by the in-OS cc — the exact developer path the #487 dogfood
// pass hit when Pong had to hand-roll a 3x5 digit font for its score.
//
// Contract legs (upstream SDL_render.c, re-derived 2026-08-15):
//   - text draws in the CURRENT render draw color at (x,y), 8 px per glyph
//   - SDL_RenderDebugTextFormat formats like printf ("SCORE %d")
//   - blank characters (space) advance the pen without drawing
//   - the draw color's ALPHA rides SDL_SetTextureAlphaMod — half-alpha white
//     over pure blue lands exactly (128,128,255), the #496 blend probe
//   - unsupported codepoints render upstream's "invalid" checkerboard glyph
//     (U+00F7 = 247 >= 190 takes upstream's early invalid branch — that quirk
//     is copied verbatim and pinned here)
//   - debug text composes with #496 render targets: text drawn into a bound
//     TARGET texture appears where the target is composited, not on the window
//   - NULL renderer / NULL str are refused (false + SDL error)
//
// Pixel expectations are exact software-arm outputs over a pure blue clear;
// probe positions are derived from the embedded font bitmaps:
//   'H' y0 = ##..##..  y3 = ######..     'I' y1 = ..##....
//   '4' y4 = #######.  '2' y6 = ######.. (space cell stays background)
//   U+00F7 -> checkerboard #.#.#.#. / .#.#.#.#     'T' y0 = ######..
//
// Run: node tests/kernel/test_sdl_debugtext_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdldbg-');

/* ---- session A: build the debug-text app in-OS, run it, shot it ---- */
const scriptA = [
  "cat > /root/dbg.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("dbgtext", 256, 128, 0);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '',
  '    /* -- contract: NULL renderer / NULL str refused with an error -- */',
  '    if (!SDL_RenderDebugText(NULL, 0, 0, "x") && strlen(SDL_GetError()) > 0)',
  '        printf("ERR-NULLR-OK\\n");',
  '    if (!SDL_RenderDebugText(r, 0, 0, NULL) && strlen(SDL_GetError()) > 0)',
  '        printf("ERR-NULLS-OK\\n");',
  '',
  '    /* -- render-target composition (#496): green "T" into a transparent',
  '       32x16 TARGET, composited later at (128,64) -- */',
  '    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, 32, 16);',
  '    if (!t) { printf("T-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    SDL_SetRenderTarget(r, t);',
  '    SDL_SetRenderDrawBlendMode(r, SDL_BLENDMODE_NONE);',
  '    SDL_SetRenderDrawColor(r, 0, 0, 0, 0);',
  '    SDL_RenderClear(r);',
  '    SDL_SetRenderDrawColor(r, 0, 255, 0, 255);',
  '    if (SDL_RenderDebugText(r, 0, 0, "T")) printf("DBG-TGT-OK\\n");',
  '    SDL_SetRenderTarget(r, NULL);',
  '',
  '    /* -- the window scene -- */',
  '    SDL_SetRenderDrawColor(r, 0, 0, 255, 255);',
  '    SDL_RenderClear(r);',
  '    SDL_SetRenderDrawColor(r, 255, 255, 255, 255);',
  '    if (SDL_RenderDebugText(r, 8, 8, "HI")) printf("DBG-TEXT-OK\\n");',
  '    SDL_SetRenderDrawColor(r, 255, 200, 0, 255);',
  '    if (SDL_RenderDebugTextFormat(r, 8, 32, "SCORE %d", 42)) printf("DBG-FMT-OK\\n");',
  '    /* U+00F7 as UTF-8: the invalid-glyph checkerboard (upstream quirk) */',
  '    SDL_SetRenderDrawColor(r, 255, 255, 255, 255);',
  '    if (SDL_RenderDebugText(r, 8, 56, "\\xc3\\xb7")) printf("DBG-UTF8-OK\\n");',
  '    /* half-alpha white H: the exact (128,128,255) blend probe */',
  '    SDL_SetRenderDrawColor(r, 255, 255, 255, 128);',
  '    if (SDL_RenderDebugText(r, 8, 80, "H")) printf("DBG-ALPHA-OK\\n");',
  '    SDL_FRect d = { 128, 64, 32, 16 };',
  '    SDL_RenderTexture(r, t, NULL, &d);',
  '    SDL_RenderPresent(r);',
  '    printf("DBG-UP\\n");',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/dbg.c -o /root/dbg && echo CC-OK',
  '/root/dbg &',
  'wmctl wait win dbgtext 15000',
  'SID=$(wmctl list | grep "dbgtext$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/dbg.png && echo shot-ok',
  // One present, one frame: debug text must not ship frames of its own
  // (atlas creation and per-glyph draws are batch entries, not presents).
  'echo SEQ-N=$(wmctl seq $SID)',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the debug-text app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));
check('NULL renderer refused with an error', a.stdout.includes('ERR-NULLR-OK'));
check('NULL str refused with an error', a.stdout.includes('ERR-NULLS-OK'));
check('debug text into a render target returned true', a.stdout.includes('DBG-TGT-OK'));
check('SDL_RenderDebugText returned true', a.stdout.includes('DBG-TEXT-OK'));
check('SDL_RenderDebugTextFormat returned true', a.stdout.includes('DBG-FMT-OK'));
check('UTF-8 input returned true', a.stdout.includes('DBG-UTF8-OK'));
check('half-alpha draw returned true', a.stdout.includes('DBG-ALPHA-OK'));
check('app composed + presented (DBG-UP)', a.stdout.includes('DBG-UP'),
  (a.stdout.match(/(INIT|WIN|RDR|T)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));
check('exactly ONE frame reached the kernel for one present',
  /SEQ-N=1\b/.test(a.stdout),
  (a.stdout.match(/SEQ-N=\d+/) || ['SEQ-N missing'])[0]);

/* ---- session B: extract the PNG shot and probe the glyphs ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/dbg.png\n',
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

    probe('background clear is blue', 200, 100, 0, 0, 255, 0);
    // "HI" white at (8,8): H y0 x0 lit, H y0 x2 unlit, H y3 x5 lit, I y1 x2 lit
    probe("'H' top-left pixel lit white", 8, 8, 255, 255, 255, 0);
    probe("'H' y0 x2 stays background (counterform)", 10, 8, 0, 0, 255, 0);
    probe("'H' crossbar (y3 x5) lit white", 13, 11, 255, 255, 255, 0);
    probe("'I' at x+8 (y1 x2) lit white — pen advanced 8", 18, 9, 255, 255, 255, 0);
    // "SCORE 42" amber at (8,32): '4' is char 6 (x 56), '2' char 7 (x 64)
    probe("format leg: '4' of 'SCORE 42' (y4 x0) lit amber", 56, 36, 255, 200, 0, 0);
    probe('format leg: the space cell stays background', 52, 36, 0, 0, 255, 0);
    probe("format leg: '2' (y6 x0) lit amber", 64, 38, 255, 200, 0, 0);
    // U+00F7 -> invalid checkerboard at (8,56): #.#. / .#.#
    probe('invalid-glyph checkerboard (0,0) lit', 8, 56, 255, 255, 255, 0);
    probe('invalid-glyph checkerboard (1,0) unlit', 9, 56, 0, 0, 255, 0);
    probe('invalid-glyph checkerboard (1,1) lit', 9, 57, 255, 255, 255, 0);
    // half-alpha white H at (8,80) over pure blue: exactly (128,128,255)
    probe('half-alpha white over blue lands (128,128,255)', 8, 80, 128, 128, 255, 1);
    probe('half-alpha H counterform stays pure blue', 10, 80, 0, 0, 255, 0);
    // target composition at (128,64): green 'T' y0 x0 lit, x6 transparent
    probe("render-target leg: 'T' lit green where composited", 128, 64, 0, 255, 0, 0);
    probe('render-target leg: transparent target region paints nothing', 134, 64, 0, 0, 255, 0);
  }
}

process.exit(failures ? 1 : 0);
