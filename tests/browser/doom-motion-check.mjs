// Timing regression guard for the no-JSPI callback model.
//
// SDL_Delay now ALWAYS throws (it can't yield without JSPI), and SDL_GetTicks
// returns full-range ms since SDL_Init. Doom paces its 35Hz tics off
// I_GetTime() == SDL_GetTicks(); with SDL_Delay gone, the *only* thing that can
// advance the game is real wall-clock time flowing through SDL_GetTicks. If
// timing were broken the canvas would freeze. This test boots the emitted Doom
// page, waits for a rendered frame, then samples the canvas over several seconds
// and asserts the picture actually CHANGES — i.e. the time-driven attract demo /
// title melt is animating. A static signature => timing is wrong.
//
// Usage: node doom-motion-check.mjs [doom.html]
import { chromium } from 'playwright';
import { spawn }    from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs   from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3177;
const PAGE = process.argv[2] || 'doom.html';
const URL  = `http://localhost:${PORT}/${PAGE}`;

if (!fs.existsSync(path.join(__dirname, 'www', PAGE))) {
  console.error(`Missing www/${PAGE} — run build-doom.mjs first.`);
  process.exit(1);
}

// A cheap order-sensitive signature of the canvas pixels.
const SIG_FN = () => {
  const c = document.querySelector('#canvas') || document.querySelector('canvas');
  if (!c || !c.width) return null;
  const s = document.createElement('canvas');
  s.width = c.width; s.height = c.height;
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i += 257) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] || d[i+1] || d[i+2]) nonBlack++;
  return { h, nonBlack, total: d.length / 4 };
};

const server  = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
const log = [];
page.on('console',  m => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await page.goto(URL);
  await page.waitForSelector('#overlay', { timeout: 15_000 });
  await page.click('#overlay');
  await page.waitForFunction(() => {
    const cc = document.getElementById('canvas-container');
    return cc && getComputedStyle(cc).display !== 'none';
  }, {}, { timeout: 45_000 });

  // Wait for the first substantially non-black frame.
  let first = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate(SIG_FN);
    if (s && s.nonBlack > s.total * 0.10) { first = s; console.log(`[motion] first frame after ~${((i+1)*1.5).toFixed(1)}s sig=${s.h}`); break; }
  }
  if (!first) throw new Error('never got a rendered frame');

  // Sample over the next ~9s; collect distinct signatures.
  const sigs = new Set([first.h]);
  const series = [first.h];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate(SIG_FN);
    if (s) { sigs.add(s.h); series.push(s.h); }
  }
  console.log('[motion] signatures over time:', series.join(' '));
  console.log('[motion] distinct frames:', sigs.size);

  if (sigs.size < 2)
    throw new Error(`canvas never changed over ~9s (${series.length} samples, all sig=${first.h}) — time-driven animation is FROZEN; SDL_GetTicks/timing is wrong`);

  console.log(`[motion] PASS — Doom animates over real time (${sigs.size} distinct frames); callback-model timing is correct without SDL_Delay`);
} catch (e) {
  console.error('[motion] FAILED:', e.message);
  for (const l of log.slice(-30)) console.error(l);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
