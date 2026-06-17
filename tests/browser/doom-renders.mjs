// Boot a compiler-emitted Doom .html page in headless Chromium, click the
// "Click to Start" overlay, let it render the title/demo, then screenshot the
// <canvas> and assert it isn't all-black (a wasm crash mid-init leaves black).
//
// Usage: node doom-renders.mjs <page.html> [screenshot.png]
//   e.g. node doom-renders.mjs doom.html shot-blockfs.png      (BLOCK_FS)
//
// This exercises the *emitted-page* filesystem backend: doom.html is compiled
// with BLOCK_FS, the only browser filesystem backend.
import { chromium } from 'playwright';
import { spawn }    from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs   from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3176;
const PAGE = process.argv[2] || 'doom.html';
const SHOT = process.argv[3] || ('shot-' + PAGE.replace(/\.html$/, '') + '.png');
const BASE = `http://localhost:${PORT}/`;
const URL  = BASE + PAGE;

function startServer() {
  const child = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stderr.write('[server] ' + d));
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up at ' + URL);
}

if (!fs.existsSync(path.join(__dirname, 'www', PAGE))) {
  console.error(`Missing www/${PAGE} — compile it first.`);
  process.exit(1);
}

const server  = startServer();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await context.newPage();

const consoleLines = [];
page.on('console',  msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

try {
  await waitForServer();
  console.log(`[test] opening ${URL}`);
  await page.goto(URL);

  // The emitted page shows a "Click to Start" overlay (a user gesture is
  // required to start audio + boot). Click it.
  await page.waitForSelector('#overlay', { timeout: 15_000 });
  console.log('[test] clicking #overlay (Click to Start)…');
  await page.click('#overlay');

  // Wait for the canvas container to become visible (it's display:none until
  // the program calls into SDL and a video mode is set).
  console.log('[test] waiting for #canvas-container to show…');
  await page.waitForFunction(() => {
    const cc = document.getElementById('canvas-container');
    return cc && getComputedStyle(cc).display !== 'none';
  }, {}, { timeout: 45_000 });

  // Give the engine real time to load the WAD off the filesystem backend and
  // render the title screen + attract-mode demo.
  console.log('[test] canvas visible. Letting Doom render…');
  await page.waitForTimeout(6000);

  const shotPath = path.join(__dirname, SHOT);
  const canvasBox = await page.locator('#canvas').boundingBox();
  await page.screenshot({ path: shotPath, clip: canvasBox });
  console.log('[test] canvas screenshot saved to', shotPath);

  const stats = await page.evaluate(async (b64) => {
    const blob = await fetch('data:image/png;base64,' + b64).then(r => r.blob());
    const img = new Image();
    img.src = window.URL.createObjectURL(blob);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0, opaque = 0, total = 0;
    const sample = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      total++;
      if (a === 255) opaque++;
      if (r !== 0 || g !== 0 || b !== 0) nonBlack++;
      if (sample.size < 16) sample.add(`${r},${g},${b}`);
    }
    return { w: c.width, h: c.height, total, opaque, nonBlack, distinct: [...sample] };
  }, fs.readFileSync(shotPath).toString('base64'));

  console.log('[test] canvas pixel stats:', JSON.stringify(stats));

  if (!(stats.opaque > stats.total * 0.95))
    throw new Error(`expected ≥95% opaque, got ${stats.opaque}/${stats.total}`);
  if (!(stats.nonBlack > stats.total * 0.10))
    throw new Error(`expected ≥10% non-black, got ${stats.nonBlack}/${stats.total} — wasm likely trapped before rendering`);

  console.log(`[test] PASS (${PAGE}) — screenshot: ${shotPath}`);
} catch (e) {
  console.error(`[test] FAILED (${PAGE}):`, e.message);
  console.error('--- page console / errors ---');
  for (const l of consoleLines.slice(-40)) console.error(l);
  try {
    const out = await page.evaluate(() => {
      const o = document.getElementById('output');
      const lc = document.getElementById('log-content');
      const s = document.getElementById('status');
      return { output: o && o.textContent, log: lc && lc.textContent, status: s && s.textContent };
    });
    console.error('--- page #status ---\n' + (out.status || ''));
    console.error('--- page #output (tail) ---\n' + ((out.output || '').slice(-2000)));
    console.error('--- page #log-content (tail) ---\n' + ((out.log || '').slice(-2000)));
    await page.screenshot({ path: path.join(__dirname, 'fail-' + SHOT), fullPage: true });
  } catch (e2) { console.error('(could not dump page state:', e2.message + ')'); }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
