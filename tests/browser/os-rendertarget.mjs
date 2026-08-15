// SDL render targets on the GPU tier (#496): the browser OS flavor runs
// SDL_Render* on createBrowserSDL's WebGPU renderer, where a render-target
// switch flushes the outgoing batch segment into its attachment (an
// rgba8unorm texture with RENDER_ATTACHMENT usage) and the window's segments
// compose across the switches. The headless twin — the same scene on the
// software tier — is tests/kernel/test_sdl_rendertarget_e2e.js; the probes
// here assert the SAME composition, so the two tiers are pinned to one
// answer.
//
// The app (callbacks model — the only GPU-present loop shape #551 permits)
// renders BOTH targets once in SDL_AppInit — before the first present, which
// also exercises the runModule pre-main device gate — and composes them every
// AppIterate frame:
//   - t1 64x64: bind #1 clears red + green square, bind #2 adds a yellow
//     square with NO clear (content must persist across re-bind: loadOp
//     'load', not 'clear');
//   - t2 16x16: transparent clear + a semi-white (a=128) top half, drawn
//     with BLEND — the transparent half must composite as NOTHING (real
//     target alpha), the semi half as ~(128,128,255) over the blue clear.
// A target that silently draws to the screen fails twice: the window clear
// erases the strays AND the composited squares never appear.
//
// The HALF-FRAME discriminator (the #484/#551 budget hazard): every
// AppIterate paints the window magenta, binds a target (flushing that
// magenta segment onto the canvas mid-frame), re-renders t3 cyan, then draws
// the real blue frame and presents. Only the present flush may fire the
// ship tail — 30 screen samples during continuous frames must never read
// magenta, and t3's cyan proves the per-frame segment machinery composes.
//
// Usage: node os-rendertarget.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3452;   // unique per member (#546)

const RT_C = `#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
static SDL_Window *w; static SDL_Renderer *r;
static SDL_Texture *t1, *t2, *t3;
SDL_AppResult SDL_AppInit(void **as, int argc, char **argv){
(void)as;(void)argc;(void)argv;
SDL_Init(SDL_INIT_VIDEO);
w=SDL_CreateWindow("rttest",256,128,0);
r=SDL_CreateRenderer(w,NULL);
if(!r)return SDL_APP_FAILURE;
t1=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,64,64);
t2=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,16,16);
if(!t1||!t2)return SDL_APP_FAILURE;
SDL_SetRenderDrawBlendMode(r,SDL_BLENDMODE_NONE);
/* bind #1: red clear + green square */
SDL_SetRenderTarget(r,t1);
SDL_SetRenderDrawColor(r,255,0,0,255);SDL_RenderClear(r);
SDL_FRect g={0,0,32,32};
SDL_SetRenderDrawColor(r,0,255,0,255);SDL_RenderFillRect(r,&g);
SDL_SetRenderTarget(r,NULL);
/* bind #2: NO clear — persistence — add a yellow square */
SDL_SetRenderTarget(r,t1);
SDL_FRect ye={32,0,32,32};
SDL_SetRenderDrawColor(r,255,255,0,255);SDL_RenderFillRect(r,&ye);
SDL_SetRenderTarget(r,NULL);
SDL_SetTextureBlendMode(t1,SDL_BLENDMODE_NONE);
/* alpha target: transparent clear + semi-white top half */
SDL_SetRenderTarget(r,t2);
SDL_SetRenderDrawColor(r,0,0,0,0);SDL_RenderClear(r);
SDL_FRect top={0,0,16,8};
SDL_SetRenderDrawColor(r,255,255,255,128);SDL_RenderFillRect(r,&top);
SDL_SetRenderTarget(r,NULL);
/* t2 keeps its default BLEND (RGBA32 alpha default) */
t3=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,16,16);
if(!t3)return SDL_APP_FAILURE;
return SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppEvent(void *as, SDL_Event *e){(void)as;
return e->type==SDL_EVENT_QUIT?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppIterate(void *as){(void)as;
SDL_SetRenderDrawBlendMode(r,SDL_BLENDMODE_NONE);
/* half-frame discriminator: paint the window MAGENTA, then bind a target —
   the bind flushes that magenta segment onto the canvas mid-frame. Only the
   PRESENT may ship a frame, so the screen must never show magenta; an
   implementation whose segment flush fires the present tail ships it. */
SDL_SetRenderDrawColor(r,255,0,255,255);SDL_RenderClear(r);
SDL_FRect full={0,0,256,128};SDL_RenderFillRect(r,&full);
SDL_SetRenderTarget(r,t3);
SDL_SetRenderDrawColor(r,0,255,255,255);SDL_RenderClear(r); /* cyan, re-rendered every frame */
SDL_SetRenderTarget(r,NULL);
/* the real frame */
SDL_SetRenderDrawColor(r,0,0,255,255);SDL_RenderClear(r);
SDL_FRect d1={32,32,64,64};SDL_RenderTexture(r,t1,NULL,&d1);
SDL_FRect d2={160,32,32,32};SDL_RenderTexture(r,t2,NULL,&d2);
SDL_FRect d3={208,32,32,32};SDL_RenderTexture(r,t3,NULL,&d3);
SDL_RenderPresent(r);
return SDL_APP_CONTINUE;}
void SDL_AppQuit(void *as, SDL_AppResult res){(void)as;(void)res;}
`;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, sample, near, waitPixel, waitScreen, waitOut } = s;

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  await waitPixel(SW - 20, SH - 60, [0, 128, 128], 60000, 'desktop teal');
  check('desktop composites', true);

  // Paste the source through the clipboard bridge, compile in-OS, launch.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setVt(1);
  await page.evaluate((src) => navigator.clipboard.writeText(src), RT_C);
  await page.keyboard.type('pbpaste > /root/rt.c && cc /root/rt.c -o /root/rttest && echo CC-O""K Z=$(wc -c < /root/rt.c)\r');
  await waitOut('CC-OK', 180000);
  // wc -c counts BYTES; the fixture's comments carry em-dashes (3 UTF-8 bytes
  // each), so the expectation is the utf8 byte length, not the JS .length.
  const rtBytes = Buffer.byteLength(RT_C, 'utf8');
  const out = await page.evaluate(() => window.__osOut || '');
  check('fixture source is the pasted source (no stale clipboard read, #562)',
    new RegExp('Z=' + rtBytes + '\\b').test(out),
    (out.match(/Z=\d+/g) || []).join(' ') + ` want Z=${rtBytes}`);

  await page.keyboard.type('/root/rttest & wmctl wait win rttest 15000 && echo UP-O""K\r');
  await waitOut('UP-OK', 30000);
  check('app window up', true);

  // First window placement is (12,36); client pixels sit at that origin.
  await setVt(2);
  await waitScreen();
  const WX = 12, WY = 36;
  await waitPixel(WX + 16, WY + 16, [0, 0, 255], 60000, 'window clear blue');
  check('window clear is blue (target draws never leaked to the screen)', true);
  await waitPixel(WX + 40, WY + 40, [0, 255, 0], 15000, 'bind #1 green square from the target');
  check('bind #1 green square composited from the target', true);
  await waitPixel(WX + 72, WY + 40, [255, 255, 0], 15000, 'bind #2 yellow square (persistence)');
  check('bind #2 yellow square (content persisted across re-bind)', true);
  await waitPixel(WX + 80, WY + 80, [255, 0, 0], 15000, 'target clear red');
  check('target clear red composited', true);
  await waitPixel(WX + 176, WY + 40, [128, 128, 255], 15000, 'semi-white target BLEND over blue');
  check('semi-white target region BLENDs over blue', true);
  await waitPixel(WX + 176, WY + 56, [0, 0, 255], 15000, 'transparent target region');
  check('transparent target region paints nothing', true);
  await waitPixel(WX + 216, WY + 40, [0, 255, 255], 15000, 't3 cyan (re-rendered into a target every frame)');
  check('per-frame target re-render composites (segment machinery under continuous use)', true);

  // ---- the half-frame discriminator ----
  // Every AppIterate paints the window MAGENTA, binds a target (flushing that
  // magenta segment onto the canvas mid-frame), then draws the real blue
  // frame and presents. Only the PRESENT may ship a bitmap; an
  // implementation whose mid-frame segment flush fires the present tail
  // ships the magenta canvas onto the screen on open ticks. 30 samples over
  // ~2s of continuous frames: the clear-blue probe must never read magenta.
  let magentaHits = 0, last = null;
  for (let i = 0; i < 30; i++) {
    last = await sample(WX + 16, WY + 16);
    if (near(last, [255, 0, 255])) magentaHits++;
    await new Promise((r) => setTimeout(r, 70));
  }
  check('mid-frame segment state never ships (screen never magenta)',
    magentaHits === 0, { magentaHits, lastSample: last });

  // Shut down cleanly; the shell must still answer.
  await setVt(1);
  await page.keyboard.type('pkill rttest; echo RT-SHELL-O""K\r');
  await waitOut('RT-SHELL-OK', 15000);
  check('shell alive after teardown', true);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os render targets (GPU tier)');
