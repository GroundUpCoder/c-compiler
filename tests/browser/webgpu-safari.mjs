// Drives the WebGPU triangle in REAL system Safari via safaridriver + selenium
// (NOT Playwright — Playwright's webkit is trunk, not shipping Safari). Confirms
// that the no-JSPI callback-model WebGPU binding renders on the engine that ships
// to iOS: compile webgpu-triangle.c -> .html, serve with COOP/COEP, navigate,
// click to start, wait for the canvas, sample pixels (center pink, corner dark
// blue), and save a screenshot.
//
// One-time: sudo safaridriver --enable  (mac-mini only; needs a display).
// Run: node webgpu-safari.mjs
import { Builder } from 'selenium-webdriver';
import 'selenium-webdriver/safari.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3188;
const URL = `http://localhost:${PORT}/webgpu-triangle.html`;

const out = path.join(__dirname, 'www', 'webgpu-triangle.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[safari] compiling webgpu-triangle.c → emitted .html …');
// --no-xterm routes stdout to the plain #log-stdout panel (cleanly readable via
// Selenium) instead of the xterm DOM renderer.
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'webgpu-triangle.c'), '-o', out, '--no-version-check', '--no-xterm'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[safari] compile failed'); process.exit(1); }

// Hard watchdog: never let safaridriver hang the run.
const watchdog = setTimeout(() => { console.error('[safari] WATCHDOG timeout — exiting'); process.exit(3); }, 90000);
watchdog.unref();
const step = (m) => console.log(`[safari] ${m}`);

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
step('waiting for server …');
for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
step('server up; starting safaridriver …');

let driver;
try {
  driver = await new Builder().forBrowser('safari').build();
  step('safaridriver session built');
} catch (e) {
  console.error('[safari] could not start safaridriver. Run `sudo safaridriver --enable` once.\n' + e.message);
  server.kill('SIGTERM');
  process.exit(2);
}

const sampleScript = `
  const c = document.getElementById('canvas');
  if (!c) return { err: 'no canvas' };
  const s = document.createElement('canvas');
  s.width = c.width; s.height = c.height;
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2] }; };
  return { w: c.width, h: c.height, center: px(c.width >> 1, c.height >> 1), corner: px(4, 4) };
`;

try {
  step('navigating …');
  await driver.get(URL);
  step('navigated; looking for overlay …');
  // Click the start overlay (user gesture). JS-click, not WebDriver .click():
  // on current Safari a native click doesn't dispatch to the handler so the
  // program never starts (canvas stays at the default 300×150, no output).
  let clicked = false;
  for (let i = 0; i < 40; i++) {
    const ok = await driver.executeScript(`const o=document.getElementById('overlay');if(o){o.click();return true;}return false;`).catch(() => false);
    if (ok) { clicked = true; break; }
    await driver.sleep(250);
  }
  step('overlay clicked=' + clicked + '; sampling …');
  // Wait for the canvas to reveal + a few frames to render.
  let s = null;
  for (let i = 0; i < 60; i++) {
    await driver.sleep(500);
    s = await driver.executeScript(sampleScript);
    if (s && s.center && (s.center.r > 100 || s.center.b > 100)) break;
  }
  console.log('[safari] sampled', JSON.stringify(s));

  // Diagnostics: the program's own stdout/stderr tells us whether the WebGPU
  // device actually came up in the worker (distinguishes a render failure from
  // a Safari canvas-readback limitation).
  const diag = await driver.executeScript(`
    const t = (id) => { const e = document.getElementById(id); return e ? (e.innerText||e.textContent||'').slice(-500) : null; };
    return { stdout: t('log-stdout'), stderr: t('log-stderr'), term: t('terminal'), gpu: typeof navigator.gpu };
  `);
  console.log('[safari] page diag:', JSON.stringify(diag));

  const png = await driver.takeScreenshot();
  fs.writeFileSync(path.join(__dirname, 'shot-webgpu-safari.png'), png, 'base64');

  const { center, corner } = s || {};
  if (!center || !(center.r > 150 && center.b > 120 && center.r > center.g + 40)) {
    throw new Error(`center not pink: ${JSON.stringify(center)}`);
  }
  if (!(corner.b > corner.r && corner.b > corner.g && corner.r < 100)) {
    throw new Error(`corner not dark-blue clear: ${JSON.stringify(corner)}`);
  }
  console.log('[safari] PASS — WebGPU triangle renders on real Safari (shot-webgpu-safari.png)');
} catch (e) {
  console.error('[safari] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  // safaridriver's quit can hang; don't let it wedge the run.
  await Promise.race([driver.quit().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  server.kill('SIGTERM');
  process.exit(process.exitCode || 0);
}
