// zz-doom-debug.mjs — SCRATCH debug driver for the deterministic os-doom
// sweep failure (todos/0074; NOT a sweep leg — the zz- prefix keeps it
// out of the os-*.mjs glob). Drives the same doom-launch flow as
// os-doom.mjs (type at VT1, __osVtSwitch(2), wait) and prints the region
// stats + wmctl list. Evidence so far: THIS flow composites a full doom
// frame ({colors:111, nonTeal:61936/61936}), while os-doom.mjs's
// waitFrame sees a static teal+icons screen with n=50032 sample points —
// a canvas-dimension anomaly at snapshot time. Delete with 0074.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = '/Users/jku/git/c-compiler';
const PORT = 3199;
const URL = `http://localhost:${PORT}/os/os.html`;
const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });
  await page.keyboard.type('doom &\r');
  await page.evaluate(() => window.__osVtSwitch(2));
  await new Promise(r => setTimeout(r, 40000));
  const stats = await page.evaluate(() => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(16, 40, 632, 392).data;
    let nonTeal = 0, n = 0;
    const colors = new Set();
    for (let i = 0; i < img.length; i += 16) {
      const col = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      colors.add(col); n++;
      if (col !== 0x008080) nonTeal++;
    }
    return { colors: colors.size, nonTeal, n };
  });
  console.log('VT2 region stats:', JSON.stringify(stats));
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.keyboard.type('wmctl list\r');
  await new Promise(r => setTimeout(r, 2000));
  const out = await page.evaluate(() => window.__osOut);
  console.log('=== list ===\n' + out.slice(-400));
} finally { await browser.close(); server.kill(); }
