// #551 browser acceptance: the blocking-main-loop GPU-present REFUSAL.
//
// A GPU-transport present issued while main() is still on the stack is
// refused at the FIRST present, unconditionally (jku ruling 2026-08-06,
// ticket #551): the process dies with a stderr message naming
// SDL_MAIN_USE_CALLBACKS as the fix and a distinct exit status (69), and
// the desktop is untouched. The trigger is the LOOP MODEL, not the sleep —
// so BOTH classic shapes must be refused identically:
//   - the SDL_Delay(1) frame loop (jku's Keep Up game shape — the loop
//     that killed the desktop at ~103s pre-#551), and
//   - the poll-only spin loop (pollball's pre-conversion shape — never
//     parks, floods hardest; a park-based trigger would NEVER fire here).
// This file carries those two shapes as fixtures (compiled in-OS with cc);
// the live demos were converted to SDL_MAIN_USE_CALLBACKS and their
// clean-run coverage lives in os-pollball.mjs / os-devloss.mjs.
//
// What replaced #484's pollball coverage: the flood this refusal forbids
// can no longer be produced by a shipped app, so the acceptance moved from
// "the flood is clamped" (old os-pollball rate band) to (a) THIS refusal
// firing before a single bitmap ships, and (b) the callback model's ships
// staying vsync-clamped (os-devloss ratio legs, os-pollball rate band).
//
// Usage: node os-loopguard.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3243;

// Shape 1 — the SDL_Delay(1) game loop (Keep Up's loop, minimized).
const DELAY_C = `#include <SDL3/SDL.h>
int main(void){SDL_Init(SDL_INIT_VIDEO);
SDL_Window*w=SDL_CreateWindow("delayloop",320,200,0);
SDL_Renderer*r=SDL_CreateRenderer(w,NULL);
for(;;){SDL_Event e;while(SDL_PollEvent(&e))if(e.type==SDL_EVENT_QUIT)return 0;
SDL_SetRenderDrawColor(r,40,200,120,255);SDL_RenderClear(r);
SDL_RenderPresent(r);SDL_Delay(1);}}
`;

// Shape 2 — the poll-only spin loop (pollball's pre-#551 shape: DELIBERATELY
// no SDL_Delay and no SDL_WaitEvent anywhere; it never parks).
const SPIN_C = `#include <SDL3/SDL.h>
int main(void){SDL_Init(SDL_INIT_VIDEO);
SDL_Window*w=SDL_CreateWindow("spinloop",320,200,0);
SDL_Renderer*r=SDL_CreateRenderer(w,NULL);
for(;;){SDL_Event e;while(SDL_PollEvent(&e))if(e.type==SDL_EVENT_QUIT)return 0;
SDL_SetRenderDrawColor(r,200,40,120,255);SDL_RenderClear(r);
SDL_RenderPresent(r);}}
`;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitPixel, waitScreen, waitOut } = s;

const readStats = () => page.evaluate(() => window.__osCompositorStats());
const osOut = () => page.evaluate(() => window.__osOut || '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const TEAL = [0, 128, 128];
  await waitPixel(SW - 20, SH - 60, TEAL, 60000);
  check('desktop composites', true);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setVt(1);
  await page.evaluate((src) => navigator.clipboard.writeText(src), DELAY_C);
  await page.keyboard.type('pbpaste > /root/delay.c && cc /root/delay.c -o /root/delayloop && echo CC1-O""K\r');
  await waitOut('CC1-OK', 180000);
  await page.evaluate((src) => navigator.clipboard.writeText(src), SPIN_C);
  await page.keyboard.type('pbpaste > /root/spin.c && cc /root/spin.c -o /root/spinloop && echo CC2-O""K\r');
  await waitOut('CC2-OK', 180000);
  check('both blocking-shape fixtures compiled in-OS', true);

  const before = await readStats();

  // ---- Shape 1: SDL_Delay(1) loop → refused at the FIRST present.
  await page.keyboard.type('/root/delayloop; echo RC1=$?\r');
  await waitOut('RC1=', 60000);
  let out = await osOut();
  check('delay-loop shape refused with exit 69', /RC1=69/.test(out),
    out.slice(-300));
  check('refusal message names the mechanism (blocking main loop)',
    out.includes('GPU rendering from a blocking main loop is not supported'),
    out.slice(-1200));
  check('refusal message teaches SDL_MAIN_USE_CALLBACKS + SDL_AppIterate',
    out.includes('SDL_MAIN_USE_CALLBACKS') && out.includes('SDL_AppIterate'),
    out.slice(-1200));
  check('refusal message carries the runtime identity (program + pid)',
    /delayloop \(pid \d+\)/.test(out), out.slice(-1200));
  // The vendor-specific budget figure must NEVER be quoted (jku ruling:
  // the 16,744-ship wall is CHROMIUM-measured; Safari's is unmeasured).
  check('refusal message quotes no vendor budget figure',
    !/16[,.]?7\d\d/.test(out), out.slice(-1200));

  // ---- Shape 2: the poll-only spin loop → same refusal, same status.
  // (The trigger is main()-on-stack, not a park: this shape never parks.)
  await page.keyboard.type('/root/spinloop; echo RC2=$?\r');
  await waitOut('RC2=', 60000);
  out = await osOut();
  check('poll-only spin shape refused with exit 69', /RC2=69/.test(out),
    out.slice(-300));

  // ---- Refused before any budget burned: zero GPU bitmaps shipped.
  const after = await readStats();
  check('refusal fired before a single GPU bitmap shipped (wmFrames flat)',
    after.wmFrames === before.wmFrames,
    { before: before.wmFrames, after: after.wmFrames });

  // ---- Only the process died: desktop composites, compositor healthy,
  // shell answers, and a callback-model GPU app still runs fine. NB the
  // compositor is ON-DEMAND (todos/0169) — it parks on an idle desktop —
  // so composite-side liveness is measured WHILE the callback app
  // presents, not on the idle desktop after the refusals.
  check('no device loss from either refusal', after.deviceLosses === 0, after);
  await setVt(2);
  await waitPixel(SW - 20, SH - 60, TEAL, 15000, 'wallpaper after refusals');
  await setVt(1);
  await page.keyboard.type('pollball & wmctl wait win pollball && echo CB-U""P\r');
  await waitOut('CB-UP', 30000);
  const f0 = await readStats();
  await page.keyboard.type('wmctl wait seq $(wmctl list | grep "pollball$" | sed "s/[^0-9].*//") 30 15000 && pkill pollball && echo CB-O""K\r');
  await waitOut('CB-OK', 60000);
  const f1 = await readStats();
  check('callback-model SDL_Renderer app still presents (30 frames) after refusals', true);
  check('compositor composites the callback app (frames flow under damage)',
    f1.frames > f0.frames, { before: f0.frames, after: f1.frames });
  await page.keyboard.type("echo GUARD-SHELL-O''K\r");
  await waitOut('GUARD-SHELL-OK', 20000);
  check('shell alive', true);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os blocking-loop refusal (browser)');
