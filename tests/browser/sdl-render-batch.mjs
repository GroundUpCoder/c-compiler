// Renderer batch/perf-refactor regression (Chromium + WebGPU). Renders a 16×16
// grid of 256 colored fill-rects (1536 verts → forces the vertex scratch AND the
// persistent GPU vertex buffer to grow past their initial 512-vert capacity), and
// samples several cells. Each cell colour is (r=i*16, g=j*16, b=128), so correct
// per-quad data + per-entry draw offsets after the in-place NDC transform and the
// single reused-buffer upload are verified end-to-end.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3203;
const URL = `http://localhost:${PORT}/sdl-render-batch.html`;
const N = 16, CELL = 18;

const out = path.join(__dirname, 'www', 'sdl-render-batch.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-render-batch] compiling …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-render-batch.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-render-batch] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 360, height: 360 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

async function cellColor(i, j) {
  const x = i * CELL + (CELL >> 1), y = j * CELL + (CELL >> 1);
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
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'shot-sdl-render-batch.png') });

  const cells = [[0, 0], [15, 0], [0, 15], [15, 15], [8, 4], [3, 11]];
  const near = (a, b) => Math.abs(a - b) <= 10;
  for (const [i, j] of cells) {
    const got = await cellColor(i, j);
    const want = { r: i * 16, g: j * 16, b: 128 };
    console.log(`[sdl-render-batch] cell(${i},${j}) want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    if (!(near(got.r, want.r) && near(got.g, want.g) && near(got.b, want.b))) {
      throw new Error(`cell(${i},${j}) color mismatch: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }
  console.log('[sdl-render-batch] PASS — 256-quad batch renders correctly through the reused/grown vertex buffer');
} catch (e) {
  console.error('[sdl-render-batch] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
