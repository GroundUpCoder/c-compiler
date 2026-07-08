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
// Usage: node os-gpubox.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3197;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

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
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

  // Launch from the real shell; the WM places the first window at (12,36).
  await page.keyboard.type('gpubox &\r');
  await setVt(2);
  const WX = 12, WY = 36, CX = WX + 128, CY = WY + 128;

  // Cube covers the window center from every rotation angle; wait for ANY
  // non-desktop, non-clear color there (face colors vary as it spins).
  const t0 = Date.now();
  let center = null;
  for (;;) {
    center = await sample(CX, CY);
    if (center && !near(center, TEAL) && !near(center, CLEAR)) break;
    if (Date.now() - t0 > 90000) throw new Error(`cube never composited at center; last ${center}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('gpubox cube composited (GPU frame through the gpu transport)', true, center);
  check('client corner is the render-pass clear color (real 3D scene, not a fill)',
    near(await sample(WX + 4, WY + 4), CLEAR), await sample(WX + 4, WY + 4));

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
  await page.keyboard.type('echo GPU-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('GPU-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after the GPU app exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos gpubox (browser): PASS' : `\nos gpubox (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
