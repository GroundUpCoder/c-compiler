// SDL_Renderer end-to-end: compile sdl-render-spike.c to an emitted page, drive
// it with bundled Chromium (+WebGPU flags), and assert the batched 2D renderer
// drew correctly — pink texture sprite in the center, green filled rect top-left,
// dark-blue clear in a far corner. Exercises CreateRenderer/CreateTexture/
// UpdateTexture/RenderTexture/RenderFillRect/RenderClear/RenderPresent on WebGPU.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3191;
const URL = `http://localhost:${PORT}/sdl-render-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-render-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-render] compiling sdl-render-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-render-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-render] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 560 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

async function px(x, y) {
  return await page.evaluate(([x, y]) => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }, [x, y]);
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

  const center = await px(320, 240);   // pink texture sprite
  const green = await px(80, 80);      // green filled rect
  const corner = await px(610, 40);    // dark-blue clear
  console.log('[sdl-render] center', JSON.stringify(center), 'green', JSON.stringify(green), 'corner', JSON.stringify(corner));
  await page.screenshot({ path: path.join(__dirname, 'shot-sdl-render.png') });

  if (!(center.r > 150 && center.b > 120 && center.r > center.g + 40)) throw new Error(`center not pink sprite: ${JSON.stringify(center)}`);
  if (!(green.g > 150 && green.g > green.r + 40 && green.g > green.b + 40)) throw new Error(`fill rect not green: ${JSON.stringify(green)}`);
  if (!(corner.b > corner.r && corner.b > corner.g && corner.r < 100)) throw new Error(`corner not dark-blue clear: ${JSON.stringify(corner)}`);

  console.log('[sdl-render] PASS — SDL_Renderer drew sprite + fill rect + clear on WebGPU');
} catch (e) {
  console.error('[sdl-render] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
