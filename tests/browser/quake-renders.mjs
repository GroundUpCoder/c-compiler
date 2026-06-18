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
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
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
  console.log('[test] Host_Init reached. Polling for a rendered frame…');

  // Quake loads an 18.7MB pak through BlockFS in a worker, so the first frame
  // can take a while. Poll the canvas via main-thread drawImage (which DOES
  // capture the worker's transferred OffscreenCanvas rendered by the WebGPU
  // blitter — proven by the WebGPU tests) until it's substantially non-black,
  // up to ~90s.
  const shotPath = path.join(__dirname, 'last-screenshot.png');
  let stats = { w: 0, h: 0, total: 0, opaque: 0, nonBlack: 0, distinct: [] };
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    stats = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c || !c.width) return { w: 0, h: 0, total: 0, opaque: 0, nonBlack: 0, distinct: [] };
      const s = document.createElement('canvas');
      s.width = c.width; s.height = c.height;
      const ctx = s.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0, opaque = 0, total = 0;
      const sample = new Set();
      for (let j = 0; j < data.length; j += 4) {
        const r = data[j], g = data[j+1], b = data[j+2], a = data[j+3];
        total++;
        if (a === 255) opaque++;
        if (r !== 0 || g !== 0 || b !== 0) nonBlack++;
        if (sample.size < 16) sample.add(`${r},${g},${b}`);
      }
      return { w: c.width, h: c.height, total, opaque, nonBlack, distinct: [...sample] };
    });
    if (stats.total > 0 && stats.nonBlack > stats.total * 0.10) {
      console.log(`[test] frame rendered after ~${(i + 1) * 2}s`);
      break;
    }
  }
  // page.screenshot captures the COMPOSITED page, which comes out black for a
  // worker-rendered WebGPU canvas in headless. Capture the actual canvas content
  // via the same drawImage path the readback uses (toDataURL of the 2D copy).
  const dataUrl = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    s.getContext('2d').drawImage(c, 0, 0);
    return s.toDataURL('image/png');
  });
  fs.writeFileSync(shotPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('[test] canvas frame saved to', shotPath);

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
