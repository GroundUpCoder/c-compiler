// Verifies the expanded WGPUVertexFormat set (Phase A2) decodes correctly:
// compiles webgpu-mapwrite.c -> .html (position fed as Float16x2, color as
// Snorm8x4 — both newly added formats), renders, and samples pixels. Center
// must be pink (proves both formats decode) and a corner the dark-blue clear.
//
// Run: node webgpu-mapwrite-renders.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3196;
const URL = `http://localhost:${PORT}/webgpu-mapwrite.html`;

const out = path.join(__dirname, 'www', 'webgpu-mapwrite.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-mapwrite] compiling webgpu-mapwrite.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-mapwrite.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-mapwrite] compile failed'); process.exit(1); }

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
  console.log('[webgpu-mapwrite] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-mapwrite.png') });

  const { center, corner } = s;
  if (!(center.r > 150 && center.b > 120 && center.r > center.g + 40)) {
    throw new Error(`center not pink (mappedAtCreation/unmap flush wrong?)): ${JSON.stringify(center)}`);
  }
  if (!(corner.b > corner.r && corner.b > corner.g && corner.r < 100)) {
    throw new Error(`corner not dark-blue clear: ${JSON.stringify(corner)}`);
  }
  console.log('[webgpu-mapwrite] PASS — mappedAtCreation + write-mapping flush (shot-webgpu-mapwrite.png)');
} catch (e) {
  console.error('[webgpu-mapwrite] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
