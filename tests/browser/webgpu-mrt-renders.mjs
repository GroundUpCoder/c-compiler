// Verifies WebGPU MRT (A10) + multiple color attachments (A11): compiles
// webgpu-mrt.c -> .html, drives it with Chromium (WebGPU via Vulkan/SwiftShader),
// waits for the canvas. webgpu-mrt.c renders TWO offscreen targets in one pass
// with different per-target write masks, reads both back on the CPU, verifies
// them in C, and paints the surface GREEN on success / RED on mismatch — so the
// pixel harness only needs to assert the surface is green.
//
// Run: node webgpu-mrt-renders.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3211;
const URL = `http://localhost:${PORT}/webgpu-mrt.html`;

const out = path.join(__dirname, 'www', 'webgpu-mrt.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-mrt] compiling webgpu-mrt.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-mrt.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-mrt] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 560 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

async function sample() {
  return await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] }; };
    return { w: c.width, h: c.height, center: px(c.width >> 1, c.height >> 1), corner: px(4, 4) };
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
  await page.waitForTimeout(1200);

  const s = await sample();
  console.log('[webgpu-mrt] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-mrt.png') });

  const { center } = s;
  // GREEN = both targets matched (target0 full pink, target1 blue-channel masked
  // out via per-target writeMask). RED = mismatch. Black = readback never landed.
  const isGreen = center.r < 40 && center.g > 200 && center.b < 40;
  if (!isGreen) throw new Error(`surface not green (MRT/mask verification failed): ${JSON.stringify(center)}`);
  const t0 = log.find(l => l.includes('TARGET0'));
  const t1 = log.find(l => l.includes('TARGET1'));
  console.log('[webgpu-mrt]', t0, '/', t1);
  console.log('[webgpu-mrt] PASS — 2 color attachments + per-target write masks (surface green)');
} catch (e) {
  console.error('[webgpu-mrt] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
