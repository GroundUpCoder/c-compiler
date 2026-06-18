// SDL3 + WebGPU end-to-end: compile sdl3webgpu-triangle.c (SDL window + SDL
// input + WebGPU render via SDL_GetWGPUSurface) to an emitted page, drive it
// with bundled Chromium (+WebGPU flags), assert the triangle renders PINK, then
// press a key and assert SDL input flipped it to CYAN. Proves the bridge, SDL
// event delivery, and WebGPU rendering all work together.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3190;
const URL = `http://localhost:${PORT}/sdl3webgpu-triangle.html`;

const out = path.join(__dirname, 'www', 'sdl3webgpu-triangle.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl3wgpu] compiling sdl3webgpu-triangle.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl3webgpu-triangle.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl3wgpu] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 560 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

async function centerPixel() {
  return await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
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

  const before = await centerPixel();
  console.log('[sdl3wgpu] before keypress (expect pink):', JSON.stringify(before));
  if (!(before.r > 150 && before.b > 120 && before.r > before.g + 40)) {
    throw new Error(`triangle not pink: ${JSON.stringify(before)}`);
  }

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const after = await centerPixel();
  console.log('[sdl3wgpu] after keypress (expect cyan):', JSON.stringify(after));
  await page.screenshot({ path: path.join(__dirname, 'shot-sdl3webgpu.png') });
  if (!(after.g > 150 && after.b > 150 && after.g > after.r + 40)) {
    throw new Error(`triangle did not flip to cyan on SDL key event: ${JSON.stringify(after)}`);
  }

  console.log('[sdl3wgpu] PASS — SDL_GetWGPUSurface render + SDL input flip pink→cyan');
} catch (e) {
  console.error('[sdl3wgpu] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
