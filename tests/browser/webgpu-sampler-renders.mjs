// Verifies WebGPU sampler completeness (A13): compiles webgpu-sampler.c -> .html,
// drives it with Chromium (WebGPU via Vulkan/SwiftShader). webgpu-sampler.c
// clears a depth32float texture to 0.5 and samples it with a COMPARISON sampler
// (compare=Less, ref=0.3) plus non-default lod clamps + maxAnisotropy; Less
// passes (0.3 < 0.5) so the surface is green. Green proves `compare` (and the
// comparison BGL/sampler pair) were honored.
//
// Run: node webgpu-sampler-renders.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3213;
const URL = `http://localhost:${PORT}/webgpu-sampler.html`;

const out = path.join(__dirname, 'www', 'webgpu-sampler.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-sampler] compiling webgpu-sampler.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-sampler.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-sampler] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));

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
  console.log('[webgpu-sampler] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-sampler.png') });

  const { center } = s;
  // GREEN = comparison sampler passed (Less: 0.3 < 0.5 -> 1.0). RED = compare
  // failed/mis-wired. Blue (clear) = nothing drawn.
  const isGreen = center.r < 40 && center.g > 200 && center.b < 40;
  if (!isGreen) throw new Error(`surface not green (comparison sampler not honored): ${JSON.stringify(center)}`);
  console.log('[webgpu-sampler] PASS — comparison sampler + lod clamps + maxAnisotropy (surface green)');
} catch (e) {
  console.error('[webgpu-sampler] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
