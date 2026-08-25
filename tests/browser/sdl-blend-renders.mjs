// SDL blend modes end-to-end: compile sdl-blend-spike.c → emitted page, drive in
// Chromium (+WebGPU flags), sample the 4 strip centers and assert each blend
// mode produced its expected pixel. Proves NONE/BLEND/ADD/MOD are actually wired
// (they used to be silent no-ops — everything was alpha-blended).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3193;
const URL = `http://localhost:${PORT}/sdl-blend-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-blend-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-blend] compiling sdl-blend-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-blend-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-blend] compile failed'); process.exit(1); }

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

const TOL = 16;
const near = (a, e) => Math.abs(a.r - e[0]) <= TOL && Math.abs(a.g - e[1]) <= TOL && Math.abs(a.b - e[2]) <= TOL;

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

  const cases = [
    { name: 'NONE',  x: 80,  exp: [102, 153, 204] },
    { name: 'BLEND', x: 240, exp: [153, 128, 128] },
    { name: 'ADD',   x: 400, exp: [255, 179, 153] },
    { name: 'MOD',   x: 560, exp: [82, 61, 41] },
  ];
  let failed = false;
  for (const c of cases) {
    const got = await px(c.x, 240);
    const ok = near(got, c.exp);
    console.log(`[sdl-blend] ${c.name.padEnd(5)} got ${JSON.stringify(got)} expected [${c.exp}] ${ok ? 'OK' : 'MISMATCH'}`);
    if (!ok) failed = true;
  }
  await page.screenshot({ path: path.join(__dirname, 'shot-sdl-blend.png') });
  if (failed) throw new Error('one or more blend modes did not match expected pixels');

  console.log('[sdl-blend] PASS — NONE/BLEND/ADD/MOD each produced the correct blended pixel');
} catch (e) {
  console.error('[sdl-blend] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
