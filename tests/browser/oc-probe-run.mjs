// Run www/oc-probe.html on one engine, report worker-draw progress, screenshot.
// Usage: node oc-probe-run.mjs <safari|chromium> [out.png]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.argv[2] || 'chromium';
const SHOT = process.argv[3] || `oc-${ENGINE}.png`;
const PORT = 3181;
const URL  = `http://localhost:${PORT}/oc-probe.html`;
const log  = (s) => process.stderr.write(`[oc:${ENGINE}] ${s}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore','pipe','pipe'] });
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
for (let i=0;i<50;i++){ try{ if((await fetch(URL)).ok) break; }catch{} await sleep(100); }

try {
  if (ENGINE === 'safari') {
    const { Builder } = await import('selenium-webdriver');
    const { Options } = await import('selenium-webdriver/safari.js');
    const driver = await new Builder().forBrowser('safari')
      .setSafariOptions(new Options().setPageLoadStrategy('eager')).build();
    try {
      await driver.manage().window().setRect({ width: 360, height: 320 });
      await driver.get(URL);
      await sleep(3000);
      const st = await driver.executeScript('return {f:window.__workerFrames||0, e:window.__workerErr||null, mp:window.__mainPixel, wp:window.__workerPixel}');
      log('worker frames=' + st.f + ' err=' + st.e);
      log('READBACK mainPixel=' + JSON.stringify(st.mp) + ' workerPixel=' + JSON.stringify(st.wp));
      fs.writeFileSync(path.join(__dirname, SHOT), Buffer.from(await driver.takeScreenshot(), 'base64'));
      log('shot=' + SHOT);
      const png = await driver.executeScript('return window.__workerPng || null;');
      if (png) { const ex = SHOT.replace(/\.png$/, '-extracted.png'); fs.writeFileSync(path.join(__dirname, ex), Buffer.from(png, 'base64')); log('EXTRACTED canvas (convertToBlob) → ' + ex); }
      else log('no __workerPng extracted');
    } finally { await driver.quit(); }
  } else {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 320 } });
      await page.goto(URL);
      await page.waitForTimeout(3000);
      const st = await page.evaluate(() => ({ f: window.__workerFrames||0, e: window.__workerErr||null }));
      log('worker frames=' + st.f + ' err=' + st.e);
      await page.screenshot({ path: path.join(__dirname, SHOT) });
      log('shot=' + SHOT);
    } finally { await browser.close(); }
  }
} catch (e) { log('FAILED: ' + e.message); process.exitCode = 1; }
finally { server.kill('SIGTERM'); log('done.'); }
