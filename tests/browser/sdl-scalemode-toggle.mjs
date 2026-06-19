// SDL_SetTextureScaleMode dynamic-change regression (Chromium + WebGPU). Compiles
// sdl-scalemode-toggle.c (one checkerboard texture whose scale mode flips
// LINEAR↔NEAREST every ~1s, AFTER its first present) and asserts the renderer
// honours the change at runtime — not just when set before the first frame.
//
// The bug this guards: texBindGroup() rebuilt the bind group only when !t.view,
// while SDL_SetTextureScaleMode nulled t.bindGroup. So a mode change once a
// texture had presented left a null bind group and the texture stopped drawing.
// We require seeing BOTH a clean LINEAR frame (blended boundary) AND a clean
// NEAREST frame (snapped boundary) where the red texel is STILL red — pre-fix the
// post-toggle frames went black (texture not drawn), which the red-centre gate
// rejects so the test fails as it should.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3200;
const URL = `http://localhost:${PORT}/sdl-scalemode-toggle.html`;

const out = path.join(__dirname, 'www', 'sdl-scalemode-toggle.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[sdl-scalemode-toggle] compiling sdl-scalemode-toggle.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-scalemode-toggle.c'), '-o', out, '--no-version-check'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[sdl-scalemode-toggle] compile failed'); process.exit(1); }

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 360, height: 360 } })).newPage();
const log = [];
page.on('console', m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

// Texture 8×8 at dst (10,10) scaled to 200×200 (25×).
//   red texel CENTRE  (col0,row1 = red): (22, 47)
//   row0/row1 BOUNDARY (black above, red below) at column 0: (22, 35)
async function sample() {
  return await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2] }; };
    return { red: px(22, 47), edge: px(22, 35) };
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

  let sawLinear = false, sawNearest = false;
  const reads = [];
  // ~8s of sampling at ~120ms spans several full LINEAR/NEAREST cycles.
  for (let i = 0; i < 66 && !(sawLinear && sawNearest); i++) {
    await page.waitForTimeout(120);
    const s = await sample();
    const alive = s.red.r > 200 && s.red.g < 60 && s.red.b < 60;     // texture still drawing
    const edgeMid = s.edge.r > 60 && s.edge.r < 200;                  // LINEAR blends the boundary
    const edgePure = s.edge.r > 225 || s.edge.r < 30;                 // NEAREST snaps the boundary
    if (alive && edgeMid) sawLinear = true;
    if (alive && edgePure) sawNearest = true;
    reads.push(`red=${s.red.r} edge=${s.edge.r} alive=${alive} mid=${edgeMid} pure=${edgePure}`);
  }
  console.log('[sdl-scalemode-toggle] sawLinear=' + sawLinear + ' sawNearest=' + sawNearest);
  await page.screenshot({ path: path.join(__dirname, 'shot-sdl-scalemode-toggle.png') });

  if (!sawLinear) throw new Error('never observed a clean LINEAR frame (blended boundary with red texel intact)');
  if (!sawNearest) {
    throw new Error('never observed a clean NEAREST frame after a runtime mode change — ' +
      'texture likely stopped drawing (null bind group) once it had presented. Readings:\n' + reads.slice(-12).join('\n'));
  }
  console.log('[sdl-scalemode-toggle] PASS — scale mode change AFTER first present is honoured');
} catch (e) {
  console.error('[sdl-scalemode-toggle] FAILED:', e.message);
  for (const l of log.slice(-40)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
