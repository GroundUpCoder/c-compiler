// Verifies the EMITTED-PAGE SDL input path through the shared SDL_WEB bridge:
// loads sdl-input-spike.html (blue until any SDL_KEYDOWN, then red), screenshots
// the canvas (expect blue), presses a key, screenshots again (expect red).
// Exercises: DOM keydown → worker.postMessage({type:'sdl-input'}) → SDL_WEB.dispatch
// → SDL_PollEvent in the program.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3179;
const URL = `http://localhost:${PORT}/sdl-input-spike.html`;

// Compile the self-contained fixture into the emitted .html we then drive.
const out = path.join(__dirname, 'www', 'sdl-input-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[check] compiling sdl-input-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-input-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[check] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
// SDL now presents via WebGPU; bundled headless Chromium needs these flags to
// surface a GPU adapter (the API is present by default, but no adapter).
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage();
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
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const i = (Math.floor(d.length / 8)) * 4; // a pixel mid-frame
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  });
}

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await page.goto(URL);
  await page.waitForSelector('#overlay', { timeout: 15000 });
  await page.click('#overlay');
  await page.waitForFunction(() => { const cc = document.getElementById('canvas-container'); return cc && getComputedStyle(cc).display !== 'none'; }, {}, { timeout: 30000 });
  await page.waitForTimeout(800);
  const before = await dominant();
  console.log('[check] before keypress:', JSON.stringify(before));
  if (!(before.b > before.r)) throw new Error(`expected BLUE before keypress, got ${JSON.stringify(before)}`);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const after = await dominant();
  console.log('[check] after keypress:', JSON.stringify(after));
  if (!(after.r > after.b)) throw new Error(`expected RED after keypress, got ${JSON.stringify(after)} — emitted-page input path broken`);

  console.log('[check] PASS — emitted-page SDL input flipped blue→red through SDL_WEB');
} catch (e) {
  console.error('[check] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
