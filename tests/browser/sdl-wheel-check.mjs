// Mouse-wheel sign end-to-end: compile sdl-wheel-spike.c → emitted page, drive in
// Chromium, hover the canvas and scroll UP (DOM deltaY < 0). Expect GREEN, i.e.
// SDL wheel.y > 0 (positive = away/up). The old code passed deltaY through, so
// scroll-up gave y<0 → RED (inverted). This guards the sign fix.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3195;
const URL = `http://localhost:${PORT}/sdl-wheel-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-wheel-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-wheel] compiling sdl-wheel-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-wheel-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-wheel] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 480, height: 360 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

async function dominant() {
  return await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const i = (Math.floor((c.width * c.height) / 2)) * 4;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  });
}

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await page.goto(URL);
  await page.waitForSelector('#overlay', { timeout: 15000 });
  await page.click('#overlay');
  await page.waitForFunction(() => {
    const cc = document.getElementById('canvas-container');
    return cc && getComputedStyle(cc).display !== 'none';
  }, {}, { timeout: 30000 });
  await page.waitForTimeout(800);

  // Hover the canvas so the wheel event targets it, then scroll up.
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);   // DOM deltaY < 0 = scroll up
  await page.waitForTimeout(500);

  const after = await dominant();
  console.log('[sdl-wheel] after scroll-up:', JSON.stringify(after));
  if (after.r > 150 && after.g < 100) throw new Error(`scroll-up produced RED → wheel sign inverted (SDL y<0): ${JSON.stringify(after)}`);
  if (!(after.g > 150 && after.g > after.r + 40 && after.g > after.b + 40)) throw new Error(`expected GREEN for scroll-up (SDL wheel.y>0), got ${JSON.stringify(after)}`);

  console.log('[sdl-wheel] PASS — scroll-up maps to SDL wheel.y > 0 (correct sign)');
} catch (e) {
  console.error('[sdl-wheel] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
