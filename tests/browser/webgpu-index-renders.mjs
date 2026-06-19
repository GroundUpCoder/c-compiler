// Verifies the WebGPU triangle renders through the emitted page: compiles
// webgpu-index.c -> .html, drives it with Chrome (system channel, which
// exposes navigator.gpu on the localhost secure origin), waits for the canvas,
// then samples pixels — center must be pink, a corner must be the dark-blue
// clear. Exercises: wgpuCreateInstance/RequestAdapter/RequestDevice (async
// callbacks, no JSPI) -> surface configure -> render pass -> draw -> submit.
//
// Run: node webgpu-renders.mjs   (uses system Chrome; falls back to headed
// Playwright Chromium if the chrome channel is unavailable).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3197;
const URL = `http://localhost:${PORT}/webgpu-index.html`;

const out = path.join(__dirname, 'www', 'webgpu-index.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-index] compiling webgpu-index.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-index.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-index] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

// Bundled Chromium DOES have WebGPU; default headless just surfaces no GPU
// adapter. These flags give it one (Vulkan backend). No system-Chrome dependency.
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 560 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

// Sample the displayed canvas: draw it to a 2D canvas and read pixels.
async function sample() {
  return await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] }; };
    return {
      w: c.width, h: c.height,
      center: px(c.width >> 1, c.height >> 1),
      corner: px(4, 4),
    };
  });
}

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await page.goto(URL);
  await page.waitForSelector('#overlay', { timeout: 15000 });
  await page.click('#overlay');
  // Canvas container reveals when wgpuSurfaceConfigure fires notifyWindow.
  await page.waitForFunction(() => {
    const cc = document.getElementById('canvas-container');
    return cc && getComputedStyle(cc).display !== 'none';
  }, {}, { timeout: 30000 });
  await page.waitForTimeout(1200); // let a few frames render

  const s = await sample();
  console.log('[webgpu-index] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-index.png') });

  const { center, corner } = s;
  // Triangle fill is pink (1.0, 0.2, 0.8): high R, high B, R>G.
  if (!(center.r > 150 && center.b > 120 && center.r > center.g + 40)) {
    throw new Error(`center not pink: ${JSON.stringify(center)}`);
  }
  // Corner is the dark-blue clear (0.10, 0.15, 0.35): B dominant, all dark.
  if (!(corner.b > corner.r && corner.b > corner.g && corner.r < 100)) {
    throw new Error(`corner not dark-blue clear: ${JSON.stringify(corner)}`);
  }
  console.log('[webgpu-index] PASS — pink triangle on dark-blue clear (shot-webgpu-index.png)');
} catch (e) {
  console.error('[webgpu-index] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
