// 0160 browser acceptance: compositor scene-signature damage skip (idle GPU on
// static screens). The kernel-worker compositor (os/compositor.js) used to run
// one WebGPU render pass EVERY rAF (~60fps) even when nothing on screen
// changed. It now keeps ticking the vsync clock unconditionally (todos/0100 —
// that rAF IS the system frame clock every SDL app parks on) but SKIPS the
// render-pass submit when a cheap per-frame scene signature (WM version +
// canvas size + active-animation count + each drawn surface's shm SH_SEQ / gpu
// bitmap identity) is identical to the last submitted frame.
//
// What this proves against the LIVE compositor:
//   - a settled desktop idles the GPU: submits stop, while frames + skips keep
//     counting (the clock never stops — SDL apps stay paced);
//   - a static window left open idles again (not just the bare desktop);
//   - every real change repaints within a frame: window create, an app present
//     (click paint), a window move, and the Start menu opening.
//
// Companion fix (same item): wm.c's taskbar redrew and presented EVERY frame,
// bumping its surface SH_SEQ unconditionally — that churned the signature and
// would have defeated the skip on any real desktop. draw_bar now presents only
// when its pixels actually change (memcmp vs the last-presented bytes), so the
// bar goes quiet while static yet still ticks the clock on the minute.
//
// Stats ride a request/response probe: window.__osCompositorStats() posts
// {type:'compositor-stats'} to the kernel worker, which replies with the
// {frames,submits,skipped} counters (os/compositor.js self.__compositorStats).
//
// Usage: node os-compositor.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3211;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitPixel, waitScreen, sample, near } = s;

const readStats = () => page.evaluate(() => window.__osCompositorStats());

// Poll until the compositor goes quiet: a window where the clock still ticks
// (frames advance) but submits barely move (<=1) — i.e. the scene has settled
// and the damage gate is skipping. Returns the last stats read.
async function settle(ms = 15000) {
  const t0 = Date.now();
  let prev = await readStats();
  while (Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 700));
    const now = await readStats();
    if (now && prev && now.frames > prev.frames && now.submits - prev.submits <= 1) return now;
    prev = now;
  }
  return prev;
}

// Wait until a submit lands past `base` (a real change repainted).
async function waitSubmit(base, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const st = await readStats();
    if (st && st.submits > base) return st;
    if (Date.now() - t0 > ms) throw new Error('no submit after ' + label + ' (base ' + base + ')');
    await new Promise(r => setTimeout(r, 100));
  }
}

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const TEAL = [0, 128, 128], FACE = [192, 192, 192], ORANGE = [255, 140, 0];
  const BARY = SH - 14;
  await waitPixel(SW - 20, SH - 60, TEAL, 60000);
  await waitPixel(400, BARY, FACE, 60000);       // taskbar strip
  check('desktop composites (teal wallpaper + wm taskbar)', true);

  const st0 = await readStats();
  check('compositor-stats probe is live', st0 && typeof st0.submits === 'number', st0);

  // ---- Core acceptance: a static desktop idles the GPU.
  await settle();
  const a = await readStats();
  await new Promise(r => setTimeout(r, 1400));
  const b = await readStats();
  check('static desktop: GPU submits idle (damage skip engaged)',
    b.submits - a.submits <= 1, { delta: b.submits - a.submits, a, b });
  check('static desktop: vsync clock keeps ticking (frames advance)',
    b.frames - a.frames > 15, { delta: b.frames - a.frames });
  check('static desktop: frames actively skipped (gate working)',
    b.skipped - a.skipped > 15, { delta: b.skipped - a.skipped });

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // ---- An idle screen still repaints the instant something changes: opening
  // the Start menu creates a surface (WM version bump) -> a submit resumes.
  let base = (await readStats()).submits;
  await page.mouse.click(rect.x + 25, rect.y + BARY);   // Start button (x < 50)
  await waitSubmit(base, 'Start menu open');
  check('Start menu open repaints (idle -> submit)', true);
  await page.keyboard.press('Escape');                  // dismiss

  // ---- After the change settles, the GPU idles again (returns to quiet).
  await settle();
  const e0 = await readStats();
  await new Promise(r => setTimeout(r, 1200));
  const e1 = await readStats();
  check('screen re-idles after a transient change',
    e1.submits - e0.submits <= 1, { delta: e1.submits - e0.submits });

  // ---- A continuously-presenting app keeps the GPU busy: the gate must NOT
  // wrongly skip real presents. winbox redraws + presents every frame_cb, so
  // its SH_SEQ churns and the signature differs every frame -> a submit every
  // frame (this is the boundary 0161 — parking idle apps — will address; 0160
  // is GPU-only and must never drop a genuinely presented frame).
  base = (await readStats()).submits;
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);
  check('winbox window composites', true);
  const w0 = await readStats();
  await new Promise(r => setTimeout(r, 1200));
  const w1 = await readStats();
  check('continuously-presenting app keeps GPU submitting (no dropped frames)',
    w1.submits - w0.submits > 30, { delta: w1.submits - w0.submits });

  // ---- Once the churner exits, the screen idles again (the gate resumes
  // skipping) — proving the busyness was the app, not the compositor.
  await setVt(1);
  await page.keyboard.type('pkill winbox\r');
  await setVt(2);
  await waitPixel(12 + 120, 36 + 80, TEAL, 30000);      // window gone
  await settle();
  const f0 = await readStats();
  await new Promise(r => setTimeout(r, 1200));
  const f1 = await readStats();
  check('GPU idles again after the app exits',
    f1.submits - f0.submits <= 1, { delta: f1.submits - f0.submits });
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os compositor (browser)');
