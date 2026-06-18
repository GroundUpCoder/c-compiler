// Drive the REAL system Safari (safaridriver + selenium-webdriver) against the
// same served DOOM/Quake pages the Chromium tests use, and screenshot what the
// canvas actually shows — the decisive check for the iOS-class risk: these pages
// transfer an OffscreenCanvas to a Worker and render via putImageData. If Safari
// doesn't composite a worker-rendered transferred OffscreenCanvas, the shot is
// black even though the Chromium shot renders.
//
// One-time: `sudo safaridriver --enable`. Usage:
//   node safari-renders.mjs doom   shot-doom-safari.png
//   node safari-renders.mjs quake  shot-quake-safari.png
import { Builder, By } from 'selenium-webdriver';
import { Options as SafariOptions } from 'selenium-webdriver/safari.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.argv[2] || 'doom';
const PAGE = MODE === 'quake' ? 'quake.html' : 'doom.html';
const SHOT = process.argv[3] || `shot-${MODE}-safari.png`;
const PORT = 3179;
const URL  = `http://localhost:${PORT}/${PAGE}`;
const log  = (s) => process.stderr.write(`[safari] ${s}\n`);  // stderr = unbuffered

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function pollScript(driver, expr, ms) {           // bounded poll, never throws
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await driver.executeScript('return (' + expr + ');')) return true; } catch {}
    await sleep(500);
  }
  return false;
}

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
    await sleep(100);
  }
  throw new Error('server did not come up at ' + URL);
}

const server = startServer();
let driver;
try {
  await waitForServer();
  log('server up; building Safari driver…');
  // 'eager' so get() returns at DOMContentLoaded, not after the worker/load
  // event (the 7.6MB Doom page + worker can otherwise stall a 'normal' wait).
  driver = await new Builder()
    .forBrowser('safari')
    .setSafariOptions(new SafariOptions().setPageLoadStrategy('eager'))
    .build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 10000 });
  await driver.manage().window().setRect({ width: 820, height: 700 });
  log(`driver up; opening ${URL}`);
  try { await driver.get(URL); } catch (e) { log('get() returned: ' + e.message); }
  log('navigated; readyState=' + await driver.executeScript('return document.readyState').catch(() => '?'));
  await driver.executeScript(`window.__werr=window.__werr||[];
    addEventListener('error',e=>window.__werr.push('error: '+(e.message||e.error)));
    addEventListener('unhandledrejection',e=>window.__werr.push('reject: '+(e.reason&&e.reason.message||e.reason)));`).catch(() => {});

  if (MODE === 'doom') {
    if (await pollScript(driver, "!!document.getElementById('overlay')", 15000)) {
      log('clicking #overlay (Click to Start)…');
      try { await driver.findElement(By.id('overlay')).click(); } catch (e) { log('overlay click: ' + e.message); }
    } else { log('no #overlay appeared'); }
    const vis = await pollScript(driver,
      "(()=>{const cc=document.getElementById('canvas-container');return !!cc&&getComputedStyle(cc).display!=='none';})()", 30000);
    log('canvas-container visible: ' + vis);
  } else {
    await driver.executeScript("if(!window.__qhook){window.__qhook=1;Promise.resolve(window.quakeBoot).then(()=>window.__qb=1);}").catch(() => {});
    const booted = await pollScript(driver, 'window.__qb===1', 30000);
    log('quakeBoot reached: ' + booted);
  }

  log('letting it render ~14s…');
  await sleep(14000);

  const b64 = await driver.takeScreenshot();
  fs.writeFileSync(path.join(__dirname, SHOT), Buffer.from(b64, 'base64'));
  log('screenshot saved to ' + SHOT);

  const txt = (id) => `((document.getElementById('${id}')||{}).textContent||'')`;
  const diag = await driver.executeScript(`return {
    coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer,
    opfs: (typeof navigator.storage!=='undefined' && !!navigator.storage.getDirectory),
    title: document.title,
    status: ${txt('status')},
    output: ${txt('output')}.slice(-1500),
    stderr: ${txt('log-stderr')}.slice(-1500),
    stdout: ${txt('log-stdout')}.slice(-800),
    logc: ${txt('log-content')}.slice(-1500),
    werr: (window.__werr||[]).join(' | ')
  };`).catch((e) => ({ err: e.message }));
  log('coi=' + diag.coi + ' sab=' + diag.sab + ' opfs=' + diag.opfs + ' title=' + diag.title);
  log('#status: ' + (diag.status || '(empty)'));
  for (const k of ['output','stderr','stdout','logc','werr']) if (diag[k]) log(`${k} tail:\n${diag[k]}`);
} catch (e) {
  log('FAILED: ' + e.message);
  process.exitCode = 1;
} finally {
  if (driver) { try { await driver.quit(); } catch {} }
  server.kill('SIGTERM');
  log('done.');
}
