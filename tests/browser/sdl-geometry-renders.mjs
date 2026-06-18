// SDL_RenderGeometry end-to-end: compile sdl-geometry-spike.c to an emitted
// page, drive with bundled Chromium (+WebGPU flags), and verify the GPU actually
// gouraud-interpolated the triangle (red/green/blue corners, gray centroid) plus
// the indexed textured quad. Saves a viewable PNG via in-page drawImage→toDataURL
// (page.screenshot of a worker WebGPU canvas is black headless).
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3192;
const URL = `http://localhost:${PORT}/sdl-geometry-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-geometry-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[geom] compiling sdl-geometry-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-geometry-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[geom] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 700, height: 560 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

// Read several points off the live canvas in one pass + return a PNG to view.
async function sample(points) {
  return await page.evaluate((pts) => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const out = {};
    for (const [name, x, y] of pts) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      out[name] = { r: d[0], g: d[1], b: d[2] };
    }
    out.__png = s.toDataURL('image/png');
    return out;
  }, points);
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

  const s = await sample([
    ['top', 320, 110],         // near red vertex
    ['bl', 165, 385],          // near green vertex
    ['br', 475, 385],          // near blue vertex
    ['centroid', 320, 293],    // equal blend → gray
    ['quad', 90, 90],          // textured pink quad
    ['corner', 600, 450],      // black clear
  ]);
  const { __png, ...pts } = s;
  console.log('[geom] samples', JSON.stringify(pts));
  fs.writeFileSync(path.join(__dirname, 'shot-sdl-geometry.png'), Buffer.from(__png.split(',')[1], 'base64'));

  const { top, bl, br, centroid, quad, corner } = pts;
  if (!(top.r > top.g + 30 && top.r > top.b + 30)) throw new Error(`top vertex not red: ${JSON.stringify(top)}`);
  if (!(bl.g > bl.r + 30 && bl.g > bl.b + 30)) throw new Error(`bottom-left not green: ${JSON.stringify(bl)}`);
  if (!(br.b > br.r + 30 && br.b > br.g + 30)) throw new Error(`bottom-right not blue: ${JSON.stringify(br)}`);
  // Centroid is an equal RGB blend — all channels present and roughly balanced.
  if (!(centroid.r > 30 && centroid.g > 30 && centroid.b > 30)) throw new Error(`centroid not an interpolated blend: ${JSON.stringify(centroid)}`);
  const mx = Math.max(centroid.r, centroid.g, centroid.b), mn = Math.min(centroid.r, centroid.g, centroid.b);
  if (!(mx - mn < 60)) throw new Error(`centroid not balanced (interp wrong): ${JSON.stringify(centroid)}`);
  if (!(quad.r > 150 && quad.b > 120 && quad.r > quad.g)) throw new Error(`textured quad not pink: ${JSON.stringify(quad)}`);
  if (!(corner.r < 30 && corner.g < 30 && corner.b < 30)) throw new Error(`corner not black clear: ${JSON.stringify(corner)}`);

  console.log('[geom] PASS — RenderGeometry: gouraud RGB triangle + indexed textured quad (shot-sdl-geometry.png)');
} catch (e) {
  console.error('[geom] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
