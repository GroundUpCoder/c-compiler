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
    const d = { frames: b.frames - a.frames, submits: b.submits - a.submits,
                notifies: b.vsyncNotifies - a.vsyncNotifies };
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
  // parked compositor: submits advance ~1/s while frames stay far below
  // free-running (~60/s) — wake, submit, re-park, every second.
  await vt1('winmine & wmctl wait win WineMine && wmctl list && echo MI""NEUP');
  await waitOut('MINEUP', 30000);
  const osOut = await page.evaluate(() => window.__osOut);
  const rows = [...osOut.matchAll(/^(\d+)\t\d+\t\S+\t\S+\t-?\d+\t\S+\tWineMine/gm)];
  check('winmine window listed', rows.length > 0);
  const sid = rows[rows.length - 1][1];
  await vt1(`wmctl click ${sid} 13 61`);                // cell (1,1): timer starts
  // NB no settle() here: the 1 Hz timer means there is never a 900ms flat
  // window — that's the point. The park/wake cycle itself is the assertion:
  // each tick's present rings the doorbell (submits advance), the compositor
  // re-parks between ticks (parks advance), and frames stay far below the
  // ~60/s free-run.
  await sleep(2000);                                    // launch transient drains
  const w0 = await readStats();
  await sleep(3500);
  const w1 = await readStats();
  check('WM_TIMER repaints reach a parked compositor (doorbell-on-present)',
    w1.submits - w0.submits >= 2, { dSubmits: w1.submits - w0.submits });
  check('...re-parking between ticks (wake, submit, park each second)',
    w1.parks - w0.parks >= 2, { dParks: w1.parks - w0.parks });
  check('...without free-running', w1.frames - w0.frames < 100,
    { dFrames: w1.frames - w0.frames });
  await vt1('pkill winmine');
  await settle();

  // ---- A continuously-presenting app keeps the GPU busy: the gate must
  // never drop a genuinely presented frame, and its vsync waits pin the
  // clock armed.
  base = (await readStats()).submits;
  await vt1('winbox &');
  await waitSubmit(base, 'winbox window maps');
  await sleep(500);                                     // steady state
  const c0 = await readStats();
  await sleep(1200);
  const c1 = await readStats();
  check('continuously-presenting app keeps submits flowing (no dropped frames)',
    c1.submits - c0.submits > 30, { delta: c1.submits - c0.submits });

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
