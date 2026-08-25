// SDL_SetWindowTitle → document.title (Chromium). The window is created as
// "sdl-title-init" then renamed to "sdl-title-changed"; we assert the page
// title ends up as the renamed value (proves both the create-window title and
// SDL_SetWindowTitle reach the DOM, not the old silent no-op).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3202;
const URL = `http://localhost:${PORT}/sdl-window-title.html`;

const out = path.join(__dirname, 'www', 'sdl-window-title.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-window-title] compiling …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-window-title.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-window-title] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 320, height: 320 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await page.goto(URL);
  await page.waitForSelector('#overlay', { timeout: 15000 });
  await page.click('#overlay');
  await page.waitForFunction(() => {
    const cc = document.getElementById('canvas-container');
    return cc && getComputedStyle(cc).display !== 'none';
  }, {}, { timeout: 30000 });
  // document.title is set from the worker's sdl-title message; poll briefly.
  await page.waitForFunction(() => document.title === 'sdl-title-changed', {}, { timeout: 10000 })
    .catch(() => {});
  const title = await page.evaluate(() => document.title);
  console.log('[sdl-window-title] document.title =', JSON.stringify(title));
  if (title !== 'sdl-title-changed') {
    throw new Error(`expected document.title "sdl-title-changed", got ${JSON.stringify(title)}`);
  }
  console.log('[sdl-window-title] PASS — SDL_SetWindowTitle updates document.title');
} catch (e) {
  console.error('[sdl-window-title] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
