// #551 browser acceptance: the blocking-main-loop GPU-present REFUSAL,
// its two sanctioned escapes, and the SDL_AppInit allowance.
//
// A SECOND GPU-transport present issued while main() is still on the stack
// is refused (jku ruling 2026-08-06, ticket #551; the FIRST is the
// SDL_AppInit splash allowance — a correct callbacks app may present once
// before its main() returns): the process dies with a stderr message
// teaching FIX 1 (SDL_RENDER_DRIVER=software — the explicit software
// opt-in, no code changes) and FIX 2 (SDL_MAIN_USE_CALLBACKS), and a
// distinct exit status (69); the desktop is untouched. The trigger is the
// LOOP MODEL, not the sleep — so BOTH classic shapes must be refused
// identically:
//   - the SDL_Delay(1) frame loop (jku's Keep Up game shape — the loop
//     that killed the desktop at ~103s pre-#551), and
//   - the poll-only spin loop (pollball's pre-conversion shape — never
//     parks, floods hardest; a park-based trigger would NEVER fire here).
// This file carries those two shapes as fixtures (compiled in-OS with cc)
// and proves BOTH escapes on them:
//   - FIX 1: the same refused delayloop binary runs fine under
//     SDL_RENDER_DRIVER=software (env var → hint → the shm rasterizer);
//   - FIX 2: a callbacks app — including one that presents inside
//     SDL_AppInit, the allowance case — runs fine on the GPU tier.
// The live demos were converted to SDL_MAIN_USE_CALLBACKS and their
// clean-run coverage lives in os-pollball.mjs / os-devloss.mjs.
//
// What replaced #484's pollball coverage: the flood this refusal forbids
// can no longer be produced by a shipped app, so the acceptance moved from
// "the flood is clamped" (old os-pollball rate band) to (a) THIS refusal
// firing within one allowance frame, and (b) the callback model's ships
// staying vsync-clamped (os-devloss ratio legs, os-pollball rate band).
//
// Usage: node os-loopguard.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3243;

// Shape 3 — a CORRECT callbacks app that presents inside SDL_AppInit (the
// allowance case): must run clean, never see the refusal.
const SPLASH_C = `#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
static SDL_Window *w; static SDL_Renderer *r; static int n;
SDL_AppResult SDL_AppInit(void **as, int argc, char **argv){
(void)as;(void)argc;(void)argv;
SDL_Init(SDL_INIT_VIDEO);
w=SDL_CreateWindow("splashcb",320,200,0);
r=SDL_CreateRenderer(w,NULL);
SDL_SetRenderDrawColor(r,20,120,220,255);SDL_RenderClear(r);
SDL_RenderPresent(r);   /* the splash present, inside AppInit */
return SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppEvent(void *as, SDL_Event *e){(void)as;
return e->type==SDL_EVENT_QUIT?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
SDL_AppResult SDL_AppIterate(void *as){(void)as;
SDL_SetRenderDrawColor(r,20,120,220,255);SDL_RenderClear(r);
SDL_RenderPresent(r);
return ++n>=90?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
void SDL_AppQuit(void *as, SDL_AppResult res){(void)as;(void)res;}
`;

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
  // Each compile line echoes the pasted source's byte count, asserted
  // against the fixture string (#562): the clipboard seam once served a
  // paste from the PREVIOUS host write (the pid-blind freshness window),
  // silently compiling fixture N from source N-1 — the refusal legs then
  // misattributed the wrong program's behavior. A stale paste now fails
  // HERE, naming the real cause (todos/0171: make the failure point at
  // its cause). The three sources have pairwise-distinct byte counts.
  await page.evaluate((src) => navigator.clipboard.writeText(src), DELAY_C);
  await page.keyboard.type('pbpaste > /root/delay.c && cc /root/delay.c -o /root/delayloop && echo CC1-O""K Z1=$(wc -c < /root/delay.c)\r');
  await waitOut('CC1-OK', 180000);
  await page.evaluate((src) => navigator.clipboard.writeText(src), SPIN_C);
  await page.keyboard.type('pbpaste > /root/spin.c && cc /root/spin.c -o /root/spinloop && echo CC2-O""K Z2=$(wc -c < /root/spin.c)\r');
  await waitOut('CC2-OK', 180000);
  await page.evaluate((src) => navigator.clipboard.writeText(src), SPLASH_C);
  await page.keyboard.type('pbpaste > /root/splash.c && cc /root/splash.c -o /root/splashcb && echo CC3-O""K Z3=$(wc -c < /root/splash.c)\r');
  await waitOut('CC3-OK', 180000);
  {
    const out3 = await osOut();
    check('fixture sources are the pasted sources (no stale clipboard read)',
      new RegExp('Z1=' + DELAY_C.length + '\\b').test(out3) &&
      new RegExp('Z2=' + SPIN_C.length + '\\b').test(out3) &&
      new RegExp('Z3=' + SPLASH_C.length + '\\b').test(out3),
      (out3.match(/Z\d=\d+/g) || []).join(' ') +
        ` want Z1=${DELAY_C.length} Z2=${SPIN_C.length} Z3=${SPLASH_C.length}`);
  }
  check('all three fixtures compiled in-OS', true);

  const before = await readStats();

  // ---- Shape 1: SDL_Delay(1) loop → refused at the FIRST present.
  // NB the wait needles anchor on DIGITS — the bare 'RC1=' substring is
  // satisfied by the tty ECHO of the typed command itself (the 0089 trap).
  await page.keyboard.type('/root/delayloop; echo RC1=$?\r');
  await page.waitForFunction(() => /RC1=\d+/.test(window.__osOut || ''), { timeout: 60000, polling: 200 });
  let out = await osOut();
  check('delay-loop shape refused with exit 69', /RC1=69/.test(out),
    out.slice(-300));
  check('refusal message names the mechanism (blocking main loop)',
    out.includes('presents GPU frames from a blocking main loop'),
    out.slice(-1200));
  check('refusal message FIX 1 teaches the software opt-in',
    out.includes('SDL_RENDER_DRIVER=software'), out.slice(-1200));
  check('refusal message FIX 2 teaches SDL_MAIN_USE_CALLBACKS + SDL_AppIterate',
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
  await page.waitForFunction(() => /RC2=\d+/.test(window.__osOut || ''), { timeout: 60000, polling: 200 });
  out = await osOut();
  check('poll-only spin shape refused with exit 69', /RC2=69/.test(out),
    out.slice(-300));

  // ---- Budget accounting: each refused app ships AT MOST the one
  // SDL_AppInit-allowance frame (the refusal fires on the SECOND main-live
  // present), so two refused apps cost <= 2 bitmaps total — never a flood.
  const after = await readStats();
  check('refusals cost at most one allowance frame each (<= 2 ships total)',
    after.wmFrames - before.wmFrames <= 2,
    { before: before.wmFrames, after: after.wmFrames });

  // ---- FIX 1 proven on the SAME refused binary: the software opt-in via
  // the env var (env → SDL_HINT_RENDER_DRIVER → the shm rasterizer). A
  // blocking loop is legal there — no GPU frames, no budget.
  await page.keyboard.type('SDL_RENDER_DRIVER=software /root/delayloop & wmctl wait win delayloop && wmctl wait seq $(wmctl list | grep "delayloop$" | sed "s/[^0-9].*//") 30 20000 && pkill delayloop && echo SW-O""K\r');
  await waitOut('SW-OK', 60000);
  check('FIX 1 works: the refused binary runs under SDL_RENDER_DRIVER=software', true);

  // ---- FIX 2 + the allowance, end to end in C: a callbacks app that
  // presents inside SDL_AppInit must run clean (the allowance) and keep
  // presenting from SDL_AppIterate — never refused, exits 0 on its own.
  await page.keyboard.type('/root/splashcb; echo RC3=$?\r');
  await page.waitForFunction(() => /RC3=\d+/.test(window.__osOut || ''), { timeout: 60000, polling: 200 });
  out = await osOut();
  check('callbacks app presenting in SDL_AppInit runs clean (exit 0, never refused)',
    /RC3=0/.test(out), out.slice(-300));

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
