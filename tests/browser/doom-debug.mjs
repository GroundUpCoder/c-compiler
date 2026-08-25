// Diagnose why the compiler-emitted doom.html worker doesn't boot on Safari.
// Builds doom-debug.html = doom.html + a pre-load instrument that wraps Worker
// and captures its error/messageerror + window errors into window.__dbg, serves
// it, drives Safari (display kept awake via caffeinate by the caller), and dumps
// the captured diagnostics. Usage: node doom-debug.mjs
import { Builder } from 'selenium-webdriver';
import { Options } from 'selenium-webdriver/safari.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 3183;
const URL = `http://localhost:${PORT}/doom-debug.html`;
const log = (s) => process.stderr.write(`[doom-dbg] ${s}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pre-load instrument: runs before the page's own scripts (injected at <head>).
const PREAMBLE = `<script>
window.__dbg = [];
var L = function(s){ try{ window.__dbg.push(String(s)); }catch(e){} };
addEventListener('error', function(e){ L('WIN error: ' + (e.message || (e.error&&e.error.message) || e.error)); });
addEventListener('unhandledrejection', function(e){ L('WIN reject: ' + ((e.reason&&e.reason.message) || e.reason)); });
var OW = self.Worker;
self.Worker = function(u, o){
  L('Worker() url=' + (typeof u==='string' ? u.slice(0,32) : u) + ' opts=' + JSON.stringify(o||{}));
  var w; try { w = new OW(u, o); } catch(err){ L('Worker() THREW: ' + err.message); throw err; }
  w.addEventListener('error', function(e){ L('WORKER error: "' + (e.message||'') + '" @' + (e.filename||'?') + ':' + (e.lineno||'?') + ':' + (e.colno||'?')); });
  w.addEventListener('messageerror', function(){ L('WORKER messageerror (structured-clone fail)'); });
  return w;
};
self.Worker.prototype = OW.prototype;
</script>`;

const src = fs.readFileSync(path.join(WWW, 'doom.html'), 'utf8');
const i = src.indexOf('<head>');
if (i < 0) { console.error('no <head> in doom.html'); process.exit(1); }
const out = src.slice(0, i + 6) + '\n' + PREAMBLE + '\n' + src.slice(i + 6);
fs.writeFileSync(path.join(WWW, 'doom-debug.html'), out);
log('built doom-debug.html (+' + PREAMBLE.length + ' bytes instrument)');

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore','pipe','pipe'] });
server.stdout.on('data', d => process.stderr.write('[server] ' + d));  // #725: was piped-and-unread
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
for (let k=0;k<50;k++){ try{ if((await fetch(URL)).ok) break; }catch{} await sleep(100); }

let driver;
try {
  driver = await new Builder().forBrowser('safari')
    .setSafariOptions(new Options().setPageLoadStrategy('eager')).build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 10000 });
  await driver.manage().window().setRect({ width: 820, height: 700 });
  log('opening ' + URL);
  try { await driver.get(URL); } catch (e) { log('get(): ' + e.message); }
  // Click the start overlay if present.
  try {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      if (await driver.executeScript("var o=document.getElementById('overlay'); if(o){o.click(); return true;} return false;").catch(()=>false)) { log('clicked #overlay'); break; }
      await sleep(400);
    }
  } catch {}
  await sleep(14000);
  const d = await driver.executeScript(`return {
    dbg: (window.__dbg||[]),
    canvasContainerShown: (function(){var cc=document.getElementById('canvas-container');return !!cc&&getComputedStyle(cc).display!=='none';})(),
    output: ((document.getElementById('output')||{}).textContent||'').slice(-1500),
    status: (document.getElementById('status')||{}).textContent
  };`).catch(e => ({ err: e.message }));
  log('canvas-container shown: ' + d.canvasContainerShown);
  log('#status: ' + (d.status||'(empty)'));
  log('=== __dbg (' + (d.dbg?d.dbg.length:0) + ' entries) ===');
  for (const line of (d.dbg||[])) log('  ' + line);
  if (d.output) log('#output tail:\n' + d.output);
  if (d.err) log('eval err: ' + d.err);
} catch (e) { log('FAILED: ' + e.message); process.exitCode = 1; }
finally { if (driver) { try { await driver.quit(); } catch {} } server.kill('SIGTERM'); log('done.'); }
