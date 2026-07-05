// WGPU_WHOLE_SIZE in the buffer-mapping path: compiles webgpu-wholesize.c →
// emitted page, drives it in Chromium. The program maps its readback buffer
// with offset 8192 + WGPU_WHOLE_SIZE / WGPU_WHOLE_MAP_SIZE and paints the
// surface with the pixel it read back — every sampled pixel must be EXACTLY
// the rendered pink. Before the fix the truncated size (0xFFFFFFFF) made
// mapAsync fail (canvas stays black) and getMappedRange abort on malloc.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3217;
const URL = `http://localhost:${PORT}/webgpu-wholesize.html`;

const out = path.join(__dirname, 'www', 'webgpu-wholesize.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[webgpu-wholesize] compiling webgpu-wholesize.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-wholesize.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[webgpu-wholesize] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

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
    return {
      w: c.width, h: c.height,
      center: px(c.width >> 1, c.height >> 1),
      corner: px(4, 4),
    };
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
  await page.waitForTimeout(1200); // let the readback land + a few frames render

  const s = await sample();
  console.log('[webgpu-wholesize] sampled', JSON.stringify(s));
  await page.screenshot({ path: path.join(__dirname, 'shot-webgpu-wholesize.png') });

  const { center, corner } = s;
  // The program paints the whole surface with the pixel it read back through
  // the WHOLE_SIZE-mapped range; exact pink (255,51,204) everywhere proves the
  // offset+rest-of-buffer mapping round-tripped the right bytes.
  const isPink = (p) => p.r === 255 && p.g === 51 && p.b === 204;
  if (!isPink(center)) throw new Error(`center not the read-back pink (WHOLE_SIZE map failed?): ${JSON.stringify(center)}`);
  if (!isPink(corner)) throw new Error(`corner not the read-back pink (WHOLE_SIZE map failed?): ${JSON.stringify(corner)}`);
  console.log('[webgpu-wholesize] PASS — WGPU_WHOLE_SIZE mapAsync + WGPU_WHOLE_MAP_SIZE getMappedRange resolved to rest-of-buffer');
} catch (e) {
  console.error('[webgpu-wholesize] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
