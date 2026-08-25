// Verifies WebGPU depth-stencil completeness (A14): compiles webgpu-depthbias.c
// -> .html, drives it with Chromium (WebGPU via Vulkan/SwiftShader).
// webgpu-depthbias.c writes depth 0.5 (pass 1, red), then in a READ-ONLY depth
// pass draws a fullscreen quad as an INDEXED TRIANGLE-STRIP at z=0.51 with
// depthBias=-2048 — the bias pulls it under 0.5 so depthCompare=Less passes and
// the quad paints green. Green proves depthBias took effect, the read-only depth
// attachment was accepted, and stripIndexFormat was honored.
//
// Run: node webgpu-depthbias-renders.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3214;
const URL = `http://localhost:${PORT}/webgpu-depthbias.html`;

const out = path.join(__dirname, 'www', 'webgpu-depthbias.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-depthbias] compiling webgpu-depthbias.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-depthbias.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-depthbias] compile failed'); process.exit(1); }

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
  console.log('[webgpu-depthbias] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-depthbias.png') });

  const { center } = s;
  // GREEN = depthBias pulled z=0.51 under 0.5 so Less passed (and the read-only
  // depth pass + indexed strip drew). RED = bias had no effect (Less failed).
  const isGreen = center.r < 40 && center.g > 200 && center.b < 40;
  if (!isGreen) throw new Error(`surface not green (depthBias/readOnly/stripIndex not honored): ${JSON.stringify(center)}`);
  console.log('[webgpu-depthbias] PASS — depthBias + read-only depth + stripIndexFormat (surface green)');
} catch (e) {
  console.error('[webgpu-depthbias] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
