// GPU-app browser acceptance (todos/0016): boot the reference OS page in
// headless Chromium and launch the seeded /bin/gpubox — an SDL window rendered
// with direct webgpu.h calls on the process worker's OWN WebGPU device, frames
// reaching the kernel compositor via the `gpu` transport (wgpuSurfacePresent ->
// transferToImageBitmap handoff, spike S1). Asserts composited desktop pixels:
// the shaded cube renders, it ANIMATES (raw webgpu.h present is live, not a
// stale frame), `wmctl resize` renegotiates the gpu-transport window
// (todos/0019: canvas + surface + depth reconfigure, bitmap-size ack), and
// `wmctl close` quits the app cleanly.
//
// Since todos/0258 (menu arch M2) gpubox is a win32 app (CS_OWNCLIENT) and
// this file is the REAL-CUBE HALF OF THE M2 ACCEPTANCE GATE (design note,
// honest-limitation #2): the headless no-Dawn e2e proves the menu machinery
// over a black client; only this leg proves the menu renders correctly over
// a LIVE GPU present — the "menubar" strip composites COLOR_MENU above the
// animating ImageBitmap client, a bar click drops a "#32768" popup child
// over the cube, and Options > Spin actually freezes the rotation
// (time-separated frame probes go equal).
//
// Usage: node os-gpubox.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3197;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 12));

  const TEAL = [0, 128, 128];
  const CLEAR = [20, 20, 64];                 // gpubox render-pass clear color

  // VTs (todos/0022): shell typing on VT1, canvas pixels on VT2 (the
  // compositor may idle while its placeholder canvas is hidden). Deep VT
  // coverage lives in os-vt.mjs.
  const { setVt } = osHelpers(page);

  // Launch from the real shell; the WM places the first window at (12,36).
  await setVt(1);   // 0070: ready lands on VT2; launch from the tty
  await page.keyboard.type('gpubox &\r');
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so rect capture / pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 'raf' });
  // 0258: the top MENU_BAR_H(30)px of the window are the "menubar" anchored
  // child strip — client probes sit BELOW it (the clear-color corner moved
  // from +4 to BAR+4).
  const BAR = 30;
  const MENUFACE = [192, 192, 192];           // COLOR_MENU, gdi32 SYSCOLORS
  const WX = 12, WY = 36, CX = WX + 128, CY = WY + BAR + 113;

  // Cube covers the window center from every rotation angle; wait for ANY
  // non-desktop, non-clear color there (face colors vary as it spins). Also
  // require the corner to be the clear color: the wm's placement MOVE is
  // async (the window renders at the kernel-cascade spot until it lands), so
  // geometry-dependent samples below must wait for the (12,36) slot for real.
  const t0 = Date.now();
  let center = null;
  for (;;) {
    center = await sample(CX, CY);
    const corner = await sample(WX + 4, WY + BAR + 4);
    if (center && !near(center, TEAL) && !near(center, CLEAR) && near(corner, CLEAR)) break;
    if (Date.now() - t0 > 90000) throw new Error(`cube never composited at center; last ${center}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('gpubox cube composited (GPU frame through the gpu transport)', true, center);
  check('client corner is the render-pass clear color (real 3D scene, not a fill)',
    near(await sample(WX + 4, WY + BAR + 4), CLEAR), await sample(WX + 4, WY + BAR + 4));

  // M2 gate: the menu bar strip child composites ABOVE the live GPU client —
  // COLOR_MENU at the strip's right end (past the File/Options titles),
  // where the parent's own frame underneath is the animating cube/clear.
  check('menu bar strip composites over the LIVE cube (COLOR_MENU)',
    near(await sample(WX + 250, WY + 10), MENUFACE), await sample(WX + 250, WY + 10));

  // Animation: an off-center probe crosses face/background boundaries as the
  // cube rotates — two samples far apart in time must differ.
  const probe = async () => [
    ...(await sample(CX + 60, CY + 60)), ...(await sample(CX - 60, CY - 60)), ...(await sample(CX, CY)),
  ];
  const a = await probe();
  let animated = false;
  for (let i = 0; i < 40 && !animated; i++) {
    await new Promise(r => setTimeout(r, 300));
    const b = await probe();
    animated = b.some((v, j) => Math.abs(v - a[j]) > 12);
  }
  check('cube animates (webgpu.h present loop is live)', animated);

  // ---- M2 gate: the menu WORKS over the live cube ----
  // A bar click drops a real "#32768" popup child over the animating client:
  // the probe point just under the bar flips from scene pixels to COLOR_MENU
  // (the popup's row-0 gutter), and ESC restores it.
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//"); wmctl click $SID 12 10\r');
  await setVt(2);
  const tP = Date.now();
  for (;;) {
    const got = await sample(WX + 2 + 8, WY + BAR + 9);   // popup-rel (8,9): row-0 gutter
    if (near(got, MENUFACE)) break;
    if (Date.now() - tP > 30000) throw new Error(`popup never composited over the cube; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('bar click opened a popup child over the live GPU client', true);
  await setVt(1);
  await page.keyboard.type('wmctl key $SID 41 27\r');   // ESC closes the popup
  await setVt(2);
  const tE = Date.now();
  for (;;) {
    const got = await sample(WX + 2 + 8, WY + BAR + 9);
    if (!near(got, MENUFACE)) break;
    if (Date.now() - tE > 30000) throw new Error(`popup never dismissed; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('ESC dismissed the popup; client pixels back', true);

  // Options > Spin via the agent path (label click, menu closed — A12): the
  // rotation freezes, so time-separated probes that just proved animation
  // now come back IDENTICAL. gpubox's marker on the tty is the sync point
  // (a posted WM_COMMAND lands on the next pump tick — never race it).
  await setVt(1);
  await page.keyboard.type('wmctl click Spin\r');
  await page.waitForFunction(() => window.__osOut.includes('gpubox: spin off'), { timeout: 20000, polling: 'raf' });
  await setVt(2);
  const s0 = await probe();
  let frozen = true;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 400));
    const s1 = await probe();
    if (s1.some((v, j) => Math.abs(v - s0[j]) > 4)) { frozen = false; break; }
  }
  check('Options>Spin froze the cube (time-separated frame probes equal)', frozen);
  // spin back on: the demo keeps animating for the resize/close legs below
  await setVt(1);
  await page.keyboard.type('wmctl click Spin\r');
  await page.waitForFunction(() => window.__osOut.includes('gpubox: spin on'), { timeout: 20000, polling: 'raf' });
  await setVt(2);

  // Client resize through the gpu transport (todos/0019): configure event ->
  // gpubox reconfigures its canvas surface + depth at 320x200 -> the first
  // new-size ImageBitmap acks and the kernel geometry follows. The probe
  // point is desktop BEFORE the resize and render-pass clear AFTER it.
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//"); wmctl resize $SID 320 200\r');
  await setVt(2);
  const tR = Date.now();
  for (;;) {
    const got = await sample(WX + 316, WY + 196);
    if (near(got, CLEAR)) break;
    if (Date.now() - tR > 30000) throw new Error(`resized client never composited; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('wmctl resize renegotiated the gpu-transport window to 320x200', true);

  // wmctl close from the shell -> SDL_EVENT_QUIT -> clean quit, window gone.
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//"); wmctl close $SID\r');
  await setVt(2);
  const t1 = Date.now();
  for (;;) {
    const got = await sample(CX, CY);
    if (near(got, TEAL)) break;
    if (Date.now() - t1 > 30000) throw new Error(`window never closed; center ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('wmctl close quit gpubox; desktop restored', true);

  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // GPU-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo GPU-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('GPU-SHELL-OK'), { timeout: 20000, polling: 'raf' });
  check('shell alive after the GPU app exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos gpubox (browser): PASS' : `\nos gpubox (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
