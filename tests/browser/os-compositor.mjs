// 0169 browser acceptance: the on-demand compositor (IDLE-POWER Stage 4;
// absorbs the reverted 0160 damage skip). The kernel-worker compositor used
// to run one WebGPU render pass EVERY rAF (~60fps) forever. Now a clean
// frame skips the submit, and once nothing needs the frame clock either
// (no pcb wantFrame pin, no vsync waiter) the rAF itself PARKS — unlike
// 0160's skip-but-keep-ticking, a settled screen advances NO counters at
// all: no frames, no submits, no per-pcb vsync notifies (the app-worker-
// wake proof).
//
// What this proves against the LIVE compositor:
//   - a settled desktop parks: frames/submits/vsyncNotifies all go flat
//     (parks counter > 0), and every wake re-parks after the change;
//   - input wakes it: opening the Start menu repaints within a beat;
//   - the doorbell-on-present covers the WM_TIMER class: winmine's seconds
//     counter keeps repainting ~1/s FROM A PARKED compositor (each present
//     rings want-frame; the compositor wakes, submits, re-parks) without
//     free-running;
//   - a continuously-presenting app (winbox) keeps submits flowing — the
//     gate never drops a genuinely presented frame — and pins the clock
//     armed (vsync waiter) so nothing is starved;
//   - the synthetic vsync-stop (compositor-freeze, the hidden-tab honest-
//     pause stand-in Playwright can't produce for real): with winbox STILL
//     RUNNING, freezing the clock parks everything — every counter flat —
//     and unfreezing resumes.
//
// Stats ride the 0160-style request/response probe: window.
// __osCompositorStats() posts {type:'compositor-stats'}; the worker replies
// with {frames,submits,skipped,parks,wakes,vsyncNotifies}.
//
// Load discipline (#444): NOTHING here counts a frame-clock-driven quantity
// against a wall clock. Host load throttles the kernel worker's rAF, so an
// absolute "N submits in 1.2s" threshold measures the box and not the
// compositor — it produced a false RED at a merge gate (every ~23s run of
// this file passed, every ~32s run failed, identical source). The frame-clock
// legs assert RATIOS between counters sampled in the SAME window (they are
// scale-free), the zero-delta legs assert exact 0 (scale-free by
// construction), and only the legs whose SOURCE is a real wall clock
// (winmine's 1 Hz WM_TIMER) count against elapsed time. Each sampled window
// is logged so a green states its own numbers.
//
// Gotchas honored: the taskbar clock repaints once a minute — a REAL wake,
// so strict flat-window asserts retry once after re-settling; VT1 typing is
// tty input (never compositor input); winmine is driven entirely by typed
// wmctl (wait win/list/click $SID 13 61 — the cell (1,1) center from
// test_winmine_e2e) so no screen-coordinate scraping.
//
// Usage: node os-compositor.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3236;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitPixel, waitScreen, waitOut } = s;

const readStats = () => page.evaluate(() => window.__osCompositorStats());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Counter deltas between two snapshots. Every sampled window is REPORTED
// (console.log), pass or fail: a leg whose numbers are only visible on a red
// cannot be reasoned about when it goes green for the wrong reason — which is
// how #444's load coupling stayed invisible until it hit a merge gate.
const delta = (a, b) => ({
  frames: b.frames - a.frames, submits: b.submits - a.submits,
  skipped: b.skipped - a.skipped, parks: b.parks - a.parks,
  wakes: b.wakes - a.wakes, notifies: b.vsyncNotifies - a.vsyncNotifies,
});

// Type a line on VT1 (tty input — never touches the compositor), back to VT2.
async function vt1(cmd) {
  await setVt(1);
  await page.keyboard.type(cmd + '\r');
  await setVt(2);
}

// Poll until the compositor PARKS: a window where the frame counter itself
// goes flat (a parked rAF produces no frames at all — 0160 merely skipped
// submits while ticking).
async function settle(ms = 25000, windowMs = 900) {
  const t0 = Date.now();
  let prev = await readStats();
  while (Date.now() - t0 < ms) {
    await sleep(windowMs);
    const now = await readStats();
    if (now && prev && now.frames === prev.frames) return now;
    prev = now;
  }
  throw new Error('compositor never parked (frames still advancing after '
    + ms + 'ms): ' + JSON.stringify(prev));
}

// Strict quiet-window deltas; one retry absorbs the once-a-minute taskbar
// clock repaint (a real wake, not noise — it can't fire twice in a window).
async function flatWindow(ms = 1500) {
  for (let attempt = 0; ; attempt++) {
    const a = await readStats();
    await sleep(ms);
    const b = await readStats();
    const d = delta(a, b);
    if ((d.frames === 0 && d.submits === 0 && d.notifies === 0) || attempt >= 1) return d;
    await settle();
  }
}

// Wait until a submit lands past `base` (a real change repainted).
async function waitSubmit(base, label, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const st = await readStats();
    if (st && st.submits > base) return st;
    if (Date.now() - t0 > ms) throw new Error('no submit after ' + label + ' (base ' + base + ')');
    await sleep(100);
  }
}

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const TEAL = [0, 128, 128], FACE = [192, 192, 192];
  const BARY = SH - 14;
  await waitPixel(SW - 20, SH - 60, TEAL, 60000);
  await waitPixel(400, BARY, FACE, 60000);       // taskbar strip
  check('desktop composites (teal wallpaper + wm taskbar)', true);

  const st0 = await readStats();
  check('compositor-stats probe is live',
    st0 && typeof st0.submits === 'number' && typeof st0.vsyncNotifies === 'number', st0);

  // ---- Core acceptance: a settled desktop PARKS — zero everything.
  const parked = await settle();
  check('settled desktop parks the rAF (parks > 0)', parked.parks > 0, parked);
  const d0 = await flatWindow();
  check('parked: zero frames, zero submits, zero app-worker notifies',
    d0.frames === 0 && d0.submits === 0 && d0.notifies === 0, d0);

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // ---- Input wakes a parked compositor: the Start menu repaints at once.
  let base = (await readStats()).submits;
  await page.mouse.click(rect.x + 25, rect.y + BARY);   // Start button (x < 50)
  await waitSubmit(base, 'Start menu open');
  check('Start menu open repaints (parked -> wake -> submit)', true);
  await page.keyboard.press('Escape');                  // dismiss
  await settle();
  const d1 = await flatWindow();
  check('re-parks after the transient (menu open/close)',
    d1.frames === 0 && d1.submits === 0 && d1.notifies === 0, d1);

  // ---- Doorbell-on-present while parked: winmine's WM_TIMER counter.
  // Launch + drive it entirely from VT1 typed wmctl (no coordinate math);
  // the cell click starts the 1 Hz timer, then each repaint must ring the
  // parked compositor: submits advance ~1/s while frames stay a small
  // multiple of them (not the ~60-per-submit of a free run) — wake, submit,
  // re-park, every second.
  await vt1('winmine & wmctl wait win WineMine && wmctl list && echo MI""NEUP');
  await waitOut('MINEUP', 30000);
  const osOut = await page.evaluate(() => window.__osOut);
  const rows = [...osOut.matchAll(/^(\d+)\t\d+\t\S+\t\S+\t-?\d+\t\S+\tWineMine/gm)];
  check('winmine window listed', rows.length > 0);
  const sid = rows[rows.length - 1][1];
  await vt1(`wmctl click ${sid} 13 71`);                // cell (1,1): timer starts (30px menu bar)
  // NB no settle() here: the 1 Hz timer means there is never a 900ms flat
  // window — that's the point. The park/wake cycle itself is the assertion:
  // each tick's present rings the doorbell (submits advance), the compositor
  // re-parks between ticks (parks advance), and each submit costs only a
  // handful of frames instead of a whole second of them.
  await sleep(2000);                                    // launch transient drains
  const w0 = await readStats();
  await sleep(3500);
  const w1 = await readStats();
  const wd = delta(w0, w1);
  console.log('       [window] winmine 1Hz timer, 3500ms: ' + JSON.stringify(wd));
  // The two floors below are anchored to a WALL-CLOCK source (winmine's 1 Hz
  // WM_TIMER, delivered by deadline out of GetMessage's kernel WAIT), not to
  // the frame clock — host load slows the compositor, not the timer — so
  // counting them against elapsed time is sound here. #444's defect was the
  // opposite: counting a FRAME-CLOCK-driven quantity against a wall clock.
  check('WM_TIMER repaints reach a parked compositor (doorbell-on-present)',
    wd.submits >= 2, wd);
  check('...re-parking between ticks (wake, submit, park each second)',
    wd.parks >= 2, wd);
  // "Not free-running" as a RATIO, not an absolute frame count (#444): a
  // free-running compositor at a load-throttled 25fps produces fewer than
  // the old `< 100`-per-3.5s frames while free-running exactly as hard, so
  // the absolute bound went VACUOUS on a loaded box — the false-green twin
  // of the leg below. Scale-free form: each 1 Hz wake costs one submit plus
  // the GRACE_FRAMES coast before the re-park, so frames stay a SMALL
  // multiple of submits (~4-5x measured); free-running is ~60 frames per
  // 1 Hz submit, an order of magnitude clear of this bound at any fps.
  check('...without free-running', wd.frames < wd.submits * 15,
    Object.assign({ perSubmit: +(wd.frames / Math.max(1, wd.submits)).toFixed(1) }, wd));
  await vt1('pkill winmine');
  await settle();

  // ---- A continuously-presenting app keeps the GPU busy: the gate must
  // never drop a genuinely presented frame, and its vsync waits pin the
  // clock armed.
  //
  // The instrument is a RATE against the frame cadence OBSERVED IN THE SAME
  // WINDOW, never an absolute submit count over a fixed wall clock (#444).
  // Host load throttles the kernel worker's rAF, so an absolute threshold
  // measures the box, not the compositor: measured 2026-08-03 on identical
  // source, every ~23s run of this file passed and every ~32s run failed at
  // 12-15 submits against the old `> 30`.
  //
  // Every tick is accounted for exactly once — draw() bumps `frames`, then
  // either `skipped` (damage gate said clean) or `submits` — so
  // `frames === submits + skipped` and "no dropped frames" IS `skipped ~= 0`:
  // while winbox presents on every vsync, a tick that submits nothing is a
  // genuinely presented frame the damage gate ate, the 0160 class this leg
  // exists to catch. A ratio is scale-free: it holds identically at 60fps and
  // at 10fps. The `frames > 0` / `submits > 0` floors keep it from passing
  // vacuously when the clock is not running at all (a stalled compositor
  // scores 0/0, which must never read as "perfect ratio").
  base = (await readStats()).submits;
  await vt1('winbox &');
  await waitSubmit(base, 'winbox window maps');
  await sleep(500);                                     // steady state
  const c0 = await readStats();
  await sleep(1200);
  const c1 = await readStats();
  const cd = delta(c0, c1);
  cd.submitRate = cd.frames > 0 ? +(cd.submits / cd.frames).toFixed(3) : 0;
  console.log('       [window] winbox churn, 1200ms: ' + JSON.stringify(cd));
  check('continuously-presenting app keeps submits flowing (no dropped frames)',
    cd.frames > 0 && cd.submits > 0 && cd.submitRate >= 0.9, cd);
  // ...and the app's vsync waits pin the clock ARMED (compKeepAlive), so the
  // churning screen never parks. Fully load-free: a park is a park at any
  // frame rate, so this leg carries no threshold at all.
  check('...pinning the clock armed (a churning screen never parks)',
    cd.parks === 0, cd);

  // ---- Synthetic vsync-stop (the hidden-tab honest pause, probe form):
  // freeze the clock with winbox STILL animating — everything parks; the
  // app's vsync wait just never resolves (no ticks), so its worker wakes
  // stop too (vsyncNotifies flat).
  await page.evaluate(() => kernel.postMessage({ type: 'compositor-freeze', on: true }));
  await sleep(400);                                     // pending draw drains
  const f0 = await readStats();
  await sleep(1200);
  const f1 = await readStats();
  check('frozen clock parks an ANIMATING app (honest pause: all counters flat)',
    f1.frames - f0.frames === 0 && f1.submits - f0.submits === 0 &&
    f1.vsyncNotifies - f0.vsyncNotifies === 0,
    { dFrames: f1.frames - f0.frames, dSubmits: f1.submits - f0.submits,
      dNotifies: f1.vsyncNotifies - f0.vsyncNotifies });
  base = (await readStats()).submits;
  await page.evaluate(() => kernel.postMessage({ type: 'compositor-freeze', on: false }));
  await waitSubmit(base, 'unfreeze');
  check('unfreeze resumes the frame race', true);

  // ---- Once the churner exits, the screen parks again — proving the
  // busyness was the app, not the compositor.
  await vt1('pkill winbox');
  await settle();
  const d2 = await flatWindow();
  check('parks again after the app exits',
    d2.frames === 0 && d2.submits === 0 && d2.notifies === 0, d2);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os compositor (browser)');
