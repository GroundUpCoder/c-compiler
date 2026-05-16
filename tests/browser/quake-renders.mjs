// Boot quake.wasm in headless Chromium, wait for a rendered frame,
// assert the canvas isn't all-black (which is what a wasm crash mid-
// init would leave). On failure, dumps the captured stdout/stderr so
// the next debugger doesn't have to bisect from zero.
//
// Run:  npm run test:quake
// (or:  npm install && npm run build:quake && npm run test:quake)
import { chromium } from 'playwright';
import { spawn }    from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs   from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3175;
const URL  = `http://localhost:${PORT}/`;

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT FAILED:', msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

function startServer() {
  const child = spawn(
    'node', [path.join(__dirname, 'server.mjs'), String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Forward server logs so a "port in use" failure is visible.
  child.stdout.on('data', d => process.stderr.write('[server] ' + d));
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(URL + 'quake.html');
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up at ' + URL);
}

// Build artifacts must exist — refuse to test stale state.
for (const f of ['quake.wasm', 'pak0.pak', 'host.js']) {
  const p = path.join(__dirname, 'www', f);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p} — run 'npm run build:quake' first.`);
    process.exit(1);
  }
}

const server  = startServer();
const browser = await chromium.launch();
const context = await browser.newContext({
  // Cross-origin isolation must be enabled in the browser too for the
  // page to use SharedArrayBuffer / sync OPFS.
  viewport: { width: 800, height: 600 },
});
const page = await context.newPage();

// Collect everything the page logs so a failure has context attached.
const consoleLines = [];
page.on('console',  msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

try {
  await waitForServer();

  console.log('[test] opening', URL);
  await page.goto(URL);

  // Wait for "Host_Init" to print — that's the marker that the wasm
  // module loaded, started, and reached our sys_sdl main(). The page
  // exposes window.quakeBoot for exactly this synchronization.
  console.log('[test] waiting for Host_Init…');
  await page.waitForFunction(() => window.quakeBoot, {}, { timeout: 30_000 });
  await page.evaluate(() => window.quakeBoot);
  console.log('[test] Host_Init reached. Letting it render some frames…');

  // Give the engine ~3 seconds of real time to run demos and update
  // the canvas. The browser's rAF will be firing at the page's natural
  // rate (headless: 60 Hz approx).
  await page.waitForTimeout(3000);

  // Sample the canvas. We need a screenshot to read pixels because the
  // canvas was transferred to an OffscreenCanvas in the worker, so
  // getImageData on the main-thread <canvas> sees a black placeholder.
  // Screenshot of the canvas region captures what's actually visible.
  const shotPath = path.join(__dirname, 'last-screenshot.png');
  const canvasBox = await page.locator('#stage').boundingBox();
  await page.screenshot({ path: shotPath, clip: canvasBox });
  console.log('[test] canvas screenshot saved to', shotPath);

  // Decode the PNG and run the same not-all-black check on it. The PNG
  // is whatever the canvas CSS size is (640×400, 2× scaled). We don't
  // bother with the PNG header — just look at the file's chunk data
  // via a tiny PNG IDAT inflater? Overkill. Instead, re-load the PNG
  // back into the page via a temporary <img>+canvas and read pixels.
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    const blob = await fetch('data:image/png;base64,' + b64).then(r => r.blob());
    img.src = URL.createObjectURL(blob);
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

  console.log('[test] canvas pixel stats:', JSON.stringify(stats, null, 2));

  assert(stats.opaque > stats.total * 0.95,
    `expected ≥95% opaque pixels, got ${stats.opaque}/${stats.total}`);
  assert(stats.nonBlack > stats.total * 0.10,
    `expected ≥10% non-black pixels (Quake's console alone fills more), ` +
    `got ${stats.nonBlack}/${stats.total} — looks like wasm trapped before VID_Update`);

  console.log('[test] PASS — screenshot:', shotPath);
} catch (e) {
  console.error('[test] FAILED:', e.message);
  console.error('--- page console / errors ---');
  for (const l of consoleLines) console.error(l);
  try {
    const pageLog = await page.evaluate(() => document.getElementById('log').textContent);
    console.error('--- page #log (wasm stdout+stderr) ---');
    console.error(pageLog);
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    console.error('--- page #status ---');
    console.error(status);
    const shotPath = path.join(__dirname, 'last-screenshot.png');
    await page.screenshot({ path: shotPath, fullPage: false });
    console.error('--- failure screenshot:', shotPath);
  } catch (e2) { console.error('(could not dump page state:', e2.message + ')'); }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
