// Scancode mapping end-to-end: compile sdl-scancode-spike.c → emitted page, drive
// in Chromium, press 'w' (expect GREEN = SDL_SCANCODE_W=26) then 's' (expect BLUE
// = SDL_SCANCODE_S=22). Proves letter scancodes are populated with correct values
// (they used to all be 0 → the program would paint RED).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3194;
const URL = `http://localhost:${PORT}/sdl-scancode-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-scancode-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-scancode] compiling sdl-scancode-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-scancode-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-scancode] compile failed'); process.exit(1); }

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

  await page.keyboard.press('w');
  await page.waitForTimeout(500);
  const afterW = await dominant();
  console.log('[sdl-scancode] after W:', JSON.stringify(afterW));
  if (afterW.r > 150 && afterW.g < 100) throw new Error(`W produced RED → scancode was 0 (unmapped): ${JSON.stringify(afterW)}`);
  if (!(afterW.g > 150 && afterW.g > afterW.r + 40 && afterW.g > afterW.b + 40)) throw new Error(`expected GREEN for W (scancode 26), got ${JSON.stringify(afterW)}`);

  await page.keyboard.press('s');
  await page.waitForTimeout(500);
  const afterS = await dominant();
  console.log('[sdl-scancode] after S:', JSON.stringify(afterS));
  if (!(afterS.b > 150 && afterS.b > afterS.r + 40 && afterS.b > afterS.g + 40)) throw new Error(`expected BLUE for S (scancode 22), got ${JSON.stringify(afterS)}`);

  console.log('[sdl-scancode] PASS — letter scancodes delivered with correct values (W=26, S=22)');
} catch (e) {
  console.error('[sdl-scancode] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
