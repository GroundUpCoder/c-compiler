// SDL_RenderDebugText on the GPU tier (#494): the browser OS flavor draws
// upstream SDL3's built-in 8x8 debug font through createBrowserSDL's WebGPU
// renderer — the atlas is a STATIC texture uploaded once via
// SDL_UpdateTexture, tinted per call by texture color/alpha mod from the
// current draw color, one textured quad per glyph. The headless twin — the
// same scene on the software tier — is tests/kernel/test_sdl_debugtext_e2e.js;
// the probes here assert the SAME composition, so the two tiers are pinned to
// one answer.
//
// Probe positions derive from the embedded font bitmaps:
//   'H' y0 = ##..##..  y3 = ######..     'I' y1 = ..##....
//   '4' y4 = #######.  (the space cell of "SCORE 42" stays background)
//   U+00F7 -> upstream's >=190 invalid-checkerboard quirk (#.#. / .#.#)
//   'T' y0 = ######.. drawn green into a #496 render target, composited
// Half-alpha white over the pure blue clear lands (128,128,255) — the #496
// blend probe. Text scale: glyphs are 8 window-pixels 1:1
// (SDL_SetRenderScale does not exist in this runtime).
//
// Usage: node os-debugtext.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3453;   // unique per member (#546)

const DBG_C = `#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
static SDL_Window *w; static SDL_Renderer *r; static SDL_Texture *t;
SDL_AppResult SDL_AppInit(void **as, int argc, char **argv){
(void)as;(void)argc;(void)argv;
SDL_Init(SDL_INIT_VIDEO);
w=SDL_CreateWindow("dbgtext",256,128,0);
r=SDL_CreateRenderer(w,NULL);
if(!r)return SDL_APP_FAILURE;
/* render-target leg (#496): green "T" into a transparent 32x16 TARGET */
t=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,32,16);
if(!t)return SDL_APP_FAILURE;
SDL_SetRenderTarget(r,t);
SDL_SetRenderDrawBlendMode(r,SDL_BLENDMODE_NONE);
SDL_SetRenderDrawColor(r,0,0,0,0);SDL_RenderClear(r);
SDL_SetRenderDrawColor(r,0,255,0,255);
if(!SDL_RenderDebugText(r,0,0,"T"))return SDL_APP_FAILURE;
SDL_SetRenderTarget(r,NULL);
return SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppEvent(void *as, SDL_Event *e){(void)as;
return e->type==SDL_EVENT_QUIT?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppIterate(void *as){(void)as;
SDL_SetRenderDrawColor(r,0,0,255,255);SDL_RenderClear(r);
SDL_SetRenderDrawColor(r,255,255,255,255);
SDL_RenderDebugText(r,8,8,"HI");
SDL_SetRenderDrawColor(r,255,200,0,255);
SDL_RenderDebugTextFormat(r,8,32,"SCORE %d",42);
SDL_SetRenderDrawColor(r,255,255,255,255);
SDL_RenderDebugText(r,8,56,"\\xc3\\xb7");   /* U+00F7: invalid-glyph quirk */
SDL_SetRenderDrawColor(r,255,255,255,128);
SDL_RenderDebugText(r,8,80,"H");           /* half-alpha blend probe */
SDL_FRect d={128,64,32,16};
SDL_RenderTexture(r,t,NULL,&d);
SDL_RenderPresent(r);
return SDL_APP_CONTINUE;}
void SDL_AppQuit(void *as, SDL_AppResult res){(void)as;(void)res;}
`;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitPixel, waitScreen, waitOut } = s;

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  await waitPixel(SW - 20, SH - 60, [0, 128, 128], 60000, 'desktop teal');
  check('desktop composites', true);

  // Paste the source through the clipboard bridge, compile in-OS, launch.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setVt(1);
  await page.evaluate((src) => navigator.clipboard.writeText(src), DBG_C);
  await page.keyboard.type('pbpaste > /root/dbg.c && cc /root/dbg.c -o /root/dbgtext && echo CC-O""K Z=$(wc -c < /root/dbg.c)\r');
  await waitOut('CC-OK', 180000);
  // wc -c counts BYTES (#562): em-dashes in comments are 3 UTF-8 bytes each.
  const dbgBytes = Buffer.byteLength(DBG_C, 'utf8');
  const out = await page.evaluate(() => window.__osOut || '');
  check('fixture source is the pasted source (no stale clipboard read, #562)',
    new RegExp('Z=' + dbgBytes + '\\b').test(out),
    (out.match(/Z=\d+/g) || []).join(' ') + ` want Z=${dbgBytes}`);

  await page.keyboard.type('/root/dbgtext & wmctl wait win dbgtext 15000 && echo UP-O""K\r');
  await waitOut('UP-OK', 30000);
  check('app window up', true);

  // First window placement is (12,36); client pixels sit at that origin.
  await setVt(2);
  await waitScreen();
  const WX = 12, WY = 36;
  await waitPixel(WX + 200, WY + 100, [0, 0, 255], 60000, 'window clear blue');
  check('background clear is blue', true);
  // "HI" white at (8,8): H y0 x0 lit / y0 x2 counterform / y3 x5 lit; I y1 x2
  await waitPixel(WX + 8, WY + 8, [255, 255, 255], 15000, "'H' top-left lit white");
  check("'H' top-left pixel lit white", true);
  await waitPixel(WX + 10, WY + 8, [0, 0, 255], 15000, "'H' y0 x2 counterform");
  check("'H' y0 x2 stays background (counterform)", true);
  await waitPixel(WX + 13, WY + 11, [255, 255, 255], 15000, "'H' crossbar (y3 x5)");
  check("'H' crossbar (y3 x5) lit white", true);
  await waitPixel(WX + 18, WY + 9, [255, 255, 255], 15000, "'I' at x+8 (y1 x2)");
  check("'I' at x+8 (y1 x2) lit white — pen advanced 8", true);
  // "SCORE 42" amber at (8,32): '4' is char 6 (x 56); the space cell is blank
  await waitPixel(WX + 56, WY + 36, [255, 200, 0], 15000, "'4' of 'SCORE 42' (y4 x0) amber");
  check("format leg: '4' of 'SCORE 42' lit amber", true);
  await waitPixel(WX + 52, WY + 36, [0, 0, 255], 15000, 'space cell background');
  check('format leg: the space cell stays background', true);
  // U+00F7 -> invalid checkerboard at (8,56)
  await waitPixel(WX + 8, WY + 56, [255, 255, 255], 15000, 'checkerboard (0,0) lit');
  check('invalid-glyph checkerboard (0,0) lit', true);
  await waitPixel(WX + 9, WY + 56, [0, 0, 255], 15000, 'checkerboard (1,0) unlit');
  check('invalid-glyph checkerboard (1,0) unlit', true);
  await waitPixel(WX + 9, WY + 57, [255, 255, 255], 15000, 'checkerboard (1,1) lit');
  check('invalid-glyph checkerboard (1,1) lit', true);
  // half-alpha white H at (8,80) over pure blue: exactly (128,128,255)
  await waitPixel(WX + 8, WY + 80, [128, 128, 255], 15000, 'half-alpha white over blue');
  check('half-alpha white over blue lands (128,128,255)', true);
  await waitPixel(WX + 10, WY + 80, [0, 0, 255], 15000, 'half-alpha counterform');
  check('half-alpha H counterform stays pure blue', true);
  // render-target composition at (128,64): green 'T' y0 x0 lit, x6 transparent
  await waitPixel(WX + 128, WY + 64, [0, 255, 0], 15000, "target 'T' green");
  check("render-target leg: 'T' lit green where composited", true);
  await waitPixel(WX + 134, WY + 64, [0, 0, 255], 15000, 'target transparent region');
  check('render-target leg: transparent target region paints nothing', true);

  // Shut down cleanly; the shell must still answer.
  await setVt(1);
  await page.keyboard.type('pkill dbgtext; echo DBG-SHELL-O""K\r');
  await waitOut('DBG-SHELL-OK', 15000);
  check('shell alive after teardown', true);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os debug text (GPU tier)');
