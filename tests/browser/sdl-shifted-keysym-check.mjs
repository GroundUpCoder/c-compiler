// Shifted-letter keycode end-to-end — pins SDL3 semantics: compile
// sdl-shifted-keysym-spike.c → emitted page, drive in Chromium, press 'a'
// (expect BLUE = 'a' 97, no shift) then Shift+A (expect GREEN = 'A' 65 +
// SDL_KMOD_SHIFT). SDL3 keycodes are MODIFIER-APPLIED — delivering the
// unshifted 'a' for Shift+A (RED) is SDL2 semantics and a conformance bug
// here (see todos/SDL3.md: a past review flagged this as broken; it isn't).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3216;
const URL = `http://localhost:${PORT}/sdl-shifted-keysym-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-shifted-keysym-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-shifted-keysym] compiling sdl-shifted-keysym-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-shifted-keysym-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-shifted-keysym] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
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

  await page.keyboard.press('KeyA');
  await page.waitForTimeout(500);
  const plain = await dominant();
  console.log('[sdl-shifted-keysym] after a:', JSON.stringify(plain));
  if (!(plain.b > 150 && plain.b > plain.r + 40 && plain.b > plain.g + 40)) throw new Error(`expected BLUE for plain 'a' (keycode 97, no shift), got ${JSON.stringify(plain)}`);

  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  const shifted = await dominant();
  console.log('[sdl-shifted-keysym] after Shift+A:', JSON.stringify(shifted));
  if (shifted.r > 150 && shifted.g < 100) throw new Error(`Shift+A produced RED → keycode was unshifted 'a' (97): SDL2 semantics. SDL3 keycodes are modifier-applied — must be 'A' (65): ${JSON.stringify(shifted)}`);
  if (!(shifted.g > 150 && shifted.g > shifted.r + 40 && shifted.g > shifted.b + 40)) throw new Error(`expected GREEN for Shift+A (keycode 'A' 65 + KMOD_SHIFT), got ${JSON.stringify(shifted)}`);

  console.log('[sdl-shifted-keysym] PASS — Shift+A delivers modifier-applied SDLK_A (65) with SDL_KMOD_SHIFT (SDL3 semantics)');
} catch (e) {
  console.error('[sdl-shifted-keysym] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
