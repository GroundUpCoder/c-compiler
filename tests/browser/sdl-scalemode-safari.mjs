// SDL_SetTextureScaleMode dynamic-change on REAL system Safari (safaridriver +
// selenium — NOT Playwright's trunk webkit). Same program as sdl-scalemode-
// toggle.mjs: a checkerboard texture whose scale mode flips LINEAR↔NEAREST every
// ~1s AFTER its first present. Proves the per-texture sampler swap is honoured at
// runtime on the engine that ships to iOS — and that pixel-art crispness works
// there at all.
//
// Pixels are read in-page via drawImage+getImageData (Safari canvas SCREENSHOTS
// come back black for a WebGPU canvas; in-page read-back is faithful — see the
// safaridriver memory). PASS requires observing BOTH a clean LINEAR frame
// (blended boundary) AND a clean NEAREST frame (snapped boundary, red intact).
//
// One-time: sudo safaridriver --enable  (mac-mini only; needs a display).
// Run: node sdl-scalemode-safari.mjs
import { Builder } from 'selenium-webdriver';
import 'selenium-webdriver/safari.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3201;
const URL = `http://localhost:${PORT}/sdl-scalemode-toggle.html`;

const out = path.join(__dirname, 'www', 'sdl-scalemode-toggle.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log('[safari] compiling sdl-scalemode-toggle.c → emitted .html …');
const r = spawnSync('node', [path.join(ROOT, 'compiler.js'),
  path.join(__dirname, 'sdl-scalemode-toggle.c'), '-o', out, '--no-version-check', '--no-xterm'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[safari] compile failed'); process.exit(1); }

const watchdog = setTimeout(() => { console.error('[safari] WATCHDOG timeout — exiting'); process.exit(3); }, 120000);
watchdog.unref();
const step = (m) => console.log(`[safari] ${m}`);

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
step('waiting for server …');
for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

// Texture 8×8 at dst (10,10) scaled 25×: red texel centre (22,47); row0/row1
// boundary (black/red) at column 0 (22,35).
const sampleScript = `
  const c = document.getElementById('canvas');
  if (!c) return { err: 'no canvas' };
  const s = document.createElement('canvas');
  s.width = c.width; s.height = c.height;
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2] }; };
  return { red: px(22, 47), edge: px(22, 35) };
`;

let driver;
try {
  driver = await new Builder().forBrowser('safari').build();
  step('safaridriver session built');
} catch (e) {
  console.error('[safari] could not start safaridriver. Run `sudo safaridriver --enable` once.\n' + e.message);
  server.kill('SIGTERM');
  process.exit(2);
}

try {
  step('navigating …');
  await driver.get(URL);
  await driver.executeScript(`window.__werr=window.__werr||[];
    addEventListener('error',e=>window.__werr.push('error: '+(e.message||e.error)));
    addEventListener('unhandledrejection',e=>window.__werr.push('reject: '+(e.reason&&e.reason.message||e.reason)));`).catch(() => {});
  // JS-click, not WebDriver .click(): on current Safari a native click on the
  // start overlay does not dispatch to the handler (the program never starts).
  // See the safaridriver gotchas memory ("JS-click on perpetual-render pages").
  let clicked = false;
  for (let i = 0; i < 40; i++) {
    const ok = await driver.executeScript(`const o=document.getElementById('overlay');if(o){o.click();return true;}return false;`).catch(() => false);
    if (ok) { clicked = true; break; }
    await driver.sleep(250);
  }
  step('overlay clicked=' + clicked + '; waiting for SDL canvas …');

  // Wait for the SDL window to appear (worker posts 'sdl-window' → canvas-container
  // becomes visible) before sampling — otherwise early reads are black.
  let visible = false;
  for (let i = 0; i < 80; i++) {
    visible = await driver.executeScript(`const cc=document.getElementById('canvas-container');return !!cc&&getComputedStyle(cc).display!=='none';`).catch(() => false);
    if (visible) break;
    await driver.sleep(250);
  }
  step('canvas visible=' + visible + '; sampling …');

  let sawLinear = false, sawNearest = false;
  const reads = [];
  for (let i = 0; i < 100 && !(sawLinear && sawNearest); i++) {
    await driver.sleep(200);
    const s = await driver.executeScript(sampleScript);
    if (!s || s.err) { reads.push('err=' + (s && s.err)); continue; }
    if (i < 6 || (i % 10 === 0)) step(`sample ${i}: red=${s.red.r},${s.red.g},${s.red.b} edge=${s.edge.r},${s.edge.g},${s.edge.b}`);
    const alive = s.red.r > 200 && s.red.g < 60 && s.red.b < 60;
    const edgeMid = s.edge.r > 60 && s.edge.r < 200;
    const edgePure = s.edge.r > 225 || s.edge.r < 30;
    if (alive && edgeMid) sawLinear = true;
    if (alive && edgePure) sawNearest = true;
    reads.push(`red=${s.red.r} edge=${s.edge.r} alive=${alive} mid=${edgeMid} pure=${edgePure}`);
  }
  step('sawLinear=' + sawLinear + ' sawNearest=' + sawNearest);

  const diag = await driver.executeScript(`
    const t = (id) => { const e = document.getElementById(id); return e ? (e.innerText||e.textContent||'').slice(-400) : null; };
    return { stdout: t('log-stdout'), stderr: t('log-stderr'), status: t('status'),
             overlay: !!document.getElementById('overlay'), title: document.title,
             coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer,
             werr: (window.__werr||[]).join(' | '), gpu: typeof navigator.gpu };
  `).catch((e) => ({ err: e.message }));
  console.log('[safari] diag:', JSON.stringify(diag));

  if (!sawLinear) throw new Error('never observed a clean LINEAR frame on Safari');
  if (!sawNearest) throw new Error('never observed a clean NEAREST frame after a runtime mode change on Safari. Readings:\n' + reads.slice(-12).join('\n'));
  console.log('[safari] PASS — scale mode change AFTER first present is honoured on real Safari');
} catch (e) {
  console.error('[safari] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await Promise.race([driver.quit().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  server.kill('SIGTERM');
  process.exit(process.exitCode || 0);
}
