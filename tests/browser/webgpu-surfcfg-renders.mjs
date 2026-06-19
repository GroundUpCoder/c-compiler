// Verifies WebGPU surface configuration completeness (A15): compiles
// webgpu-surfcfg.c -> .html, drives it with Chromium (WebGPU via
// Vulkan/SwiftShader). webgpu-surfcfg.c configures the surface as rgba8unorm
// with viewFormats=[rgba8unorm-srgb] (+ presentMode Fifo, alphaMode Opaque),
// then renders linear 0.5 red through an rgba8unorm-srgb VIEW of the surface
// texture. The srgb view encodes 0.5 linear -> ~188 in the stored byte; a plain
// rgba8unorm view would store 128. center.r near 188 proves the srgb view
// format (hence viewFormats) was honored — without it createView would fail.
//
// Run: node webgpu-surfcfg-renders.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3215;
const URL = `http://localhost:${PORT}/webgpu-surfcfg.html`;

const out = path.join(__dirname, 'www', 'webgpu-surfcfg.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-surfcfg] compiling webgpu-surfcfg.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-surfcfg.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-surfcfg] compile failed'); process.exit(1); }

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
  console.log('[webgpu-surfcfg] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-surfcfg.png') });

  const { center } = s;
  // srgb-encoded 0.5 ≈ 188; a non-srgb (plain) view would be ~128. The wide-ish
  // window (180–196) tolerates rounding while clearly excluding the 128 case.
  if (!(center.r >= 180 && center.r <= 196 && center.g < 20 && center.b < 20)) {
    throw new Error(`center not srgb-encoded red ~188 (viewFormats not honored?): ${JSON.stringify(center)}`);
  }
  console.log('[webgpu-surfcfg] PASS — viewFormats srgb view + presentMode + alphaMode (srgb-encoded red', center.r + ')');
} catch (e) {
  console.error('[webgpu-surfcfg] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
