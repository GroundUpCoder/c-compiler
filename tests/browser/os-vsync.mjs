// SDL_SetRenderVSync in the real browser OS (#500): the compositor's rAF is
// the display clock (kernel.vsyncTick per composited frame), so this member
// measures pacing against the REAL ~60Hz tick — the headless twin
// (tests/kernel/test_render_vsync_e2e.js) owns the deterministic-tick,
// contract and STOP legs.
//
// Legs:
//   - software tier, BLOCKING loop (the #551 opt-in every classic game uses):
//     vsync=1 self-measures ~tick-rate fps; vsync=0 floods (>10x faster) —
//     the paced/unpaced CONTRAST is the load-bearing pair, so a wedged clock
//     or a no-op setter cannot pass both.
//   - GPU tier, callback loop: SDL_SetRenderVSync accepted, vsync=2 halves
//     the iterate cadence (~30fps at 60Hz) — the frame-driver pacing seam.
//   - contract spot-check through the real veneer (default 0, round-trip).
//   - the desktop survives (__osState ready).
//
// Usage: node os-vsync.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3454;   // unique per member (#546)

const SW_C = `#include <SDL3/SDL.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 1;    /* vsync mode to set */
    int frames = argc > 2 ? atoi(argv[2]) : 120;
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *w = SDL_CreateWindow("vsb", 96, 64, 0);
    SDL_Renderer *r = SDL_CreateRenderer(w, "software");
    if (!r) { printf("NOREND %s\\n", SDL_GetError()); return 2; }
    int v = 99;
    SDL_GetRenderVSync(r, &v); printf("DEFAULT=%d\\n", v);
    printf("SET=%d\\n", (int)SDL_SetRenderVSync(r, n));
    SDL_GetRenderVSync(r, &v); printf("GET=%d\\n", v);
    SDL_Event e;
    Uint64 t0 = SDL_GetTicks();
    for (int i = 0; i < frames; i++) {
        while (SDL_PollEvent(&e)) {}
        SDL_SetRenderDrawColor(r, i & 255, 40, 80, 255);
        SDL_RenderClear(r);
        SDL_RenderPresent(r);
    }
    Uint64 d = SDL_GetTicks() - t0;
    printf("SWFPS %.1f ELAPSED %llu FRAMES %d\\n",
           frames * 1000.0 / (double)(d ? d : 1), (unsigned long long)d, frames);
    fflush(stdout);
    SDL_Quit();
    return 0;
}
`;

const GPU_C = `#define SDL_MAIN_USE_CALLBACKS
#include <SDL3/SDL.h>
#include <stdio.h>
static SDL_Window *w; static SDL_Renderer *r;
static int n = 0; static Uint64 t0;
SDL_AppResult SDL_AppInit(void **as, int argc, char **argv) {
    (void)as; (void)argc; (void)argv;
    SDL_Init(SDL_INIT_VIDEO);
    w = SDL_CreateWindow("vsg", 96, 64, 0);
    r = SDL_CreateRenderer(w, NULL);          /* GPU tier */
    if (!r) return SDL_APP_FAILURE;
    int v = 99;
    SDL_GetRenderVSync(r, &v); printf("GDEFAULT=%d\\n", v);
    printf("GSET=%d\\n", (int)SDL_SetRenderVSync(r, 2));
    SDL_GetRenderVSync(r, &v); printf("GGET=%d\\n", v);
    fflush(stdout);
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *as, SDL_Event *e) {
    (void)as;
    return e->type == SDL_EVENT_QUIT ? SDL_APP_SUCCESS : SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *as) {
    (void)as;
    if (n == 0) t0 = SDL_GetTicks();
    n++;
    SDL_SetRenderDrawColor(r, n & 255, 80, 40, 255);
    SDL_RenderClear(r);
    SDL_RenderPresent(r);
    if (n > 60) {
        Uint64 d = SDL_GetTicks() - t0;
        printf("GPUFPS %.1f ELAPSED %llu ITER %d\\n",
               60 * 1000.0 / (double)(d ? d : 1), (unsigned long long)d, 60);
        fflush(stdout);
        return SDL_APP_SUCCESS;
    }
    return SDL_APP_CONTINUE;
}
void SDL_AppQuit(void *as, SDL_AppResult res) { (void)as; (void)res; }
`;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitOut } = s;

const grab = (out, re) => { const m = re.exec(out); return m ? Number(m[1]) : null; };

try {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setVt(1);

  await page.evaluate((src) => navigator.clipboard.writeText(src), SW_C);
  await page.keyboard.type('pbpaste > /root/vsb.c && cc /root/vsb.c -o /root/vsb && echo CC1-O""K\r');
  await waitOut('CC1-OK', 180000);
  await page.evaluate((src) => navigator.clipboard.writeText(src), GPU_C);
  await page.keyboard.type('pbpaste > /root/vsg.c && cc /root/vsg.c -o /root/vsg && echo CC2-O""K\r');
  await waitOut('CC2-OK', 180000);
  check('both apps compile in-OS', true);

  // -- software tier, vsync=1: paced at the real compositor tick ----------
  await page.keyboard.type('/root/vsb 1 120 > /root/v1.out 2>&1; echo V""1-DONE\r');
  await waitOut('V1-DONE', 60000);
  // -- software tier, vsync=0: the unpaced flood (the contrast control) ----
  await page.keyboard.type('/root/vsb 0 600 > /root/v0.out 2>&1; echo V""0-DONE\r');
  await waitOut('V0-DONE', 60000);
  // -- GPU tier, callback, vsync=2 ----------------------------------------
  await page.keyboard.type('/root/vsg > /root/vg.out 2>&1; echo V""G-DONE\r');
  await waitOut('VG-DONE', 60000);
  await page.keyboard.type('cat /root/v1.out /root/v0.out /root/vg.out; echo CA""T-DONE\r');
  await waitOut('CAT-DONE', 30000);

  const out = await page.evaluate(() => window.__osOut || '');
  check('sw contract: fresh renderer reports 0, set/get round-trips 1',
    out.includes('DEFAULT=0') && out.includes('SET=1') && out.includes('GET=1'));

  // Headless Chromium's rAF is not locked to a real display (measured ~80Hz
  // on this harness), so the band is deliberately wide; frames-per-tick
  // EXACTNESS is pinned deterministically in test_render_vsync_e2e.js. The
  // load-bearing assert is the 10x paced/unpaced CONTRAST below.
  const fps1 = grab(out, /SWFPS ([\d.]+) ELAPSED \d+ FRAMES 120/);
  check('sw vsync=1 paces to the compositor tick (fps 40..130)',
    fps1 !== null && fps1 >= 40 && fps1 <= 130, `fps=${fps1}`);

  const fps0 = grab(out, /SWFPS ([\d.]+) ELAPSED \d+ FRAMES 600/);
  check('sw vsync=0 stays unpaced (the SDL default; >10x the paced rate)',
    fps0 !== null && fps1 !== null && fps0 > fps1 * 10, `fps0=${fps0} fps1=${fps1}`);

  check('gpu contract: default 0, vsync=2 accepted, round-trips',
    out.includes('GDEFAULT=0') && out.includes('GSET=1') && out.includes('GGET=2'));
  // Relative, not absolute: the divisor claim is HALF the tick cadence,
  // whatever cadence this harness's rAF actually runs (see fps1 note).
  const fpsg = grab(out, /GPUFPS ([\d.]+) ELAPSED \d+ ITER 60/);
  check('gpu vsync=2 halves the iterate cadence (~fps1/2)',
    fpsg !== null && fps1 !== null && fpsg >= fps1 * 0.35 && fpsg <= fps1 * 0.65,
    `fpsg=${fpsg} fps1=${fps1}`);

  const osState = await page.evaluate(() => window.__osState);
  check('desktop survives (__osState ready)', osState === 'ready', osState);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os renderer vsync (#500)');
