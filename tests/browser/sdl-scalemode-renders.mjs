// SDL_SetTextureScaleMode end-to-end: compile sdl-scalemode-spike.c → emitted
// page, drive in Chromium (+WebGPU flags), sample the nearest (left) and linear
// (right) checkerboard strips and assert the nearest side shows crisp pixel-art
// blocks while the linear side is blurred. Proves SDL_SCALEMODE_NEAREST/LINEAR
// map to actual GPU sampler state.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3199;
const URL = `http://localhost:${PORT}/sdl-scalemode-spike.html`;

const out = path.join(__dirname, 'www', 'sdl-scalemode-spike.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-scalemode] compiling sdl-scalemode-spike.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-scalemode-spike.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-scalemode] compile failed'); process.exit(1); }

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
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
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

  // The checkerboard is 8×8 rendered at 200×200 (25× scale). Source texel (sx,sy)
  // maps to dst pixel: x = dstX + (sx+0.5)/8 * 200 = dstX + (sx+0.5)*25.
  // Red texels have (sx+sy)&1 == 1 (e.g. (0,1), (1,0), (1,2), …).
  //
  // NEAREST texture at (10,140). Sample texel (0,1) = red:
  //   dst center ~(22, 178). Should be pure red with nearest.
  const nearRed = await px(22, 178);
  console.log('[sdl-scalemode] NEAREST red    ', JSON.stringify(nearRed));

  // LINEAR texture at (430,140). Sample the same texel (0,1) center:
  //   dst center ~(442, 178). Bilinear blends with black neighbors → muted red.
  const linRed = await px(442, 178);
  console.log('[sdl-scalemode] LINEAR  red    ', JSON.stringify(linRed));

  // NEAREST texture: sample texel (0,0) = black, center ~(22, 153).
  const nearBlack = await px(22, 153);
  console.log('[sdl-scalemode] NEAREST black  ', JSON.stringify(nearBlack));

  // Boundary between texel (0,0) black and (0,1) red: at y=165.
  // NEAREST snaps to one or the other → should be either pure black or pure red.
  // LINEAR blends → should be a medium red (not pure, not black).
  const nearEdge = await px(22, 165);
  const linEdge = await px(442, 165);
  console.log('[sdl-scalemode] NEAREST edge   ', JSON.stringify(nearEdge));
  console.log('[sdl-scalemode] LINEAR  edge   ', JSON.stringify(linEdge));

  await page.screenshot({ path: path.join(__dirname, 'shot-sdl-scalemode.png') });

  // NEAREST red texel center: should be pure red
  if (!(nearRed.r > 200 && nearRed.r > nearRed.g + 150 && nearRed.r > nearRed.b + 150)) {
    throw new Error(`NEAREST red texel not pure red — expected sharp pixels: ${JSON.stringify(nearRed)}`);
  }
  // NEAREST black texel center: should be near-black
  if (!(nearBlack.r < 60 && nearBlack.g < 60 && nearBlack.b < 60)) {
    throw new Error(`NEAREST black texel not dark — expected sharp pixels: ${JSON.stringify(nearBlack)}`);
  }
  // LINEAR at the same red-texel center: bilinear is 98%-weighted toward the
  // red texel, so r will be only slightly less than 255. The edge case below is
  // the strong signal. But r must still be less than the NEAREST counterpart.
  if (!(linRed.r <= nearRed.r && linRed.r > 200)) {
    throw new Error(`LINEAR red not in expected range: nearest=${JSON.stringify(nearRed)} linear=${JSON.stringify(linRed)}`);
  }
  // At the boundary between a black and red texel: nearest snaps sharply to one
  // colour (pure red or pure black), linear shows visible blending (~mid-range).
  if (nearEdge.r > 100 && nearEdge.r < 200) {
    throw new Error(`NEAREST edge shows blending (mid-range r=${nearEdge.r}) — sampler likely linear, not nearest`);
  }
  // LINEAR edge should be a blended medium value (not pure red, not pure black)
  if (!(linEdge.r > 40 && linEdge.r < 220)) {
    throw new Error(`LINEAR edge not blended as expected: ${JSON.stringify(linEdge)}`);
  }

  console.log('[sdl-scalemode] PASS — NEAREST preserves pixel-art, LINEAR blurs');
} catch (e) {
  console.error('[sdl-scalemode] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
