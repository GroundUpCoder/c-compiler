// Verifies the WebGPU triangle renders through the emitted page: compiles
// webgpu-stencil.c -> .html, drives it with Chrome (system channel, which
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
const PORT = 3207;
const URL = `http://localhost:${PORT}/webgpu-stencil.html`;

const out = path.join(__dirname, 'www', 'webgpu-stencil.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-stencil] compiling webgpu-stencil.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-stencil.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-stencil] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));

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
  console.log('[webgpu-stencil] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-stencil.png') });

  const { center, corner } = s;
  // Center is inside the small stencil-masked quad: the fullscreen green draw
  // passed (stencil==1) -> GREEN. Without the stencil test green would cover the
  // whole screen including the corner.
  if (!(center.g > 200 && center.r < 60 && center.b < 60)) {
    throw new Error(`center not green (stencil mask failed): ${JSON.stringify(center)}`);
  }
  // Corner is outside the mask (stencil==0): the green draw was rejected, so the
  // BLUE clear shows. If it were green, the stencil test didn't gate the draw.
  if (!(corner.b > 200 && corner.g < 60 && corner.r < 60)) {
    throw new Error(`corner not blue (stencil did not mask the fullscreen green): ${JSON.stringify(corner)}`);
  }
  console.log('[webgpu-stencil] PASS — stencil mask: fullscreen green gated to the stencil==1 region (center green, corner blue)');
} catch (e) {
  console.error('[webgpu-stencil] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
