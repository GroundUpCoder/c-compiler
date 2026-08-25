// Extract an ACTUAL Quake frame rendered by real Safari, display-independent:
// quake-worker.js convertToBlob()s its OffscreenCanvas every 1.5s and posts the
// PNG; quake.html exposes the latest as window.__quakeFrame. We poll it and save.
// Run the display awake: `caffeinate -u -t 3; caffeinate -du node quake-extract.mjs`.
import { Builder } from 'selenium-webdriver';
import { Options } from 'selenium-webdriver/safari.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3185;
const URL = `http://localhost:${PORT}/quake.html`;
const OUT = 'quake-safari-extracted.png';
const log = (s) => process.stderr.write(`[quake-x] ${s}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore','pipe','pipe'] });
server.stdout.on('data', d => process.stderr.write('[server] ' + d));  // #725: was piped-and-unread
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
for (let k=0;k<50;k++){ try{ if((await fetch(URL)).ok) break; }catch{} await sleep(100); }

let driver;
try {
  driver = await new Builder().forBrowser('safari')
    .setSafariOptions(new Options().setPageLoadStrategy('eager')).build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 10000 });
  await driver.manage().window().setRect({ width: 760, height: 620 });
  log('opening ' + URL);
  try { await driver.get(URL); } catch (e) { log('get(): ' + e.message); }

  // Poll for frames; save the latest each time it advances. Quake needs time to
  // load 18MB pak + reach a rendered console/scene.
  let last = 0, saved = 0;
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const st = await driver.executeScript('return {n:window.__quakeFrames||0, has:!!window.__quakeFrame, st:(document.getElementById("status")||{}).textContent}').catch(() => ({}));
    if (st.n && st.n !== last) {
      last = st.n;
      const png = await driver.executeScript('return window.__quakeFrame||null;');
      if (png) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(png, 'base64')); saved++; log(`saved frame #${st.n} (status: ${st.st})`); }
    }
    await sleep(1500);
  }
  log(`done polling; ${saved} frame(s) extracted → ${OUT}`);
} catch (e) { log('FAILED: ' + e.message); process.exitCode = 1; }
finally { if (driver) { try { await driver.quit(); } catch {} } server.kill('SIGTERM'); log('done.'); }
