// Extract a rendered frame from the COMPILER-EMITTED doom.html (the `-o x.html`
// self-contained format) on real Safari — closing the gap that quake-extract.mjs
// (a hand-written harness) didn't cover. We can't edit the emitted worker, so we
// inject from the page: wrap Blob() to PREPEND a capture shim to the worker
// source (the emitted page builds its worker via new Blob([workerSource])), and
// wrap Worker() to receive the frames the shim posts. The shim watches incoming
// worker messages for the transferred OffscreenCanvas, then convertToBlob()s it
// every 1.5s — display- and screenshot-independent.
// Run display awake: `caffeinate -u -t 3; caffeinate -du node doom-extract.mjs`.
import { Builder } from 'selenium-webdriver';
import { Options } from 'selenium-webdriver/safari.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 3187;
const URL = `http://localhost:${PORT}/doom-extract.html`;
const OUT = 'doom-safari-extracted.png';
const log = (s) => process.stderr.write(`[doom-x] ${s}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runs INSIDE the emitted worker (prepended to its source). Finds the
// OffscreenCanvas the page transfers in, then ships PNG frames back.
const WORKER_SHIM = `(function(){
  // host.js's SDL present path is WebGPU now (NOT Canvas2D putImageData): DOOM
  // software-renders an RGBA framebuffer and blitPresent() uploads it via
  // GPUQueue.writeTexture before drawing it to a webgpu canvas. So capture the
  // REAL frame at writeTexture — plain RGBA bytes + dims — and reconstruct it via
  // a scratch 2D OffscreenCanvas (whose convertToBlob is reliable on every
  // engine, unlike convertToBlob on a webgpu-context canvas). Display- and
  // screenshot-independent. Also tee console.error to surface any WebGPU-init
  // failure host.js logs on Safari.
  var last=null, count=0, herr=null;
  try {
    if (typeof GPUQueue !== 'undefined' && GPUQueue.prototype.writeTexture) {
      var OWT = GPUQueue.prototype.writeTexture;
      GPUQueue.prototype.writeTexture = function(dest, data, layout, size){
        try {
          var w = size.width, h = size.height, bpr = layout.bytesPerRow;
          var src = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer || data);
          last = { w: w, h: h, bpr: bpr, bytes: src.slice() }; count++;
        } catch(e){ herr = ''+e; }
        return OWT.apply(this, arguments);
      };
    } else { herr = 'no GPUQueue'; }
  } catch(e){ herr = ''+e; }
  try { var oce = console.error; console.error = function(){ try{ self.postMessage({ __cerr: Array.prototype.map.call(arguments, String).join(' ') }); }catch(_){}; return oce.apply(console, arguments); }; } catch(e){}
  self.postMessage({ __shim: 1, hasGPUQueue: typeof GPUQueue !== 'undefined', herr: herr });
  setInterval(function(){
    if (!last) { self.postMessage({ __beat: { count: count, herr: herr } }); return; }
    try {
      var w=last.w, h=last.h, bpr=last.bpr, src=last.bytes;
      var sc = new OffscreenCanvas(w, h), ctx = sc.getContext('2d');
      var img = ctx.createImageData(w, h), dst = img.data;
      for (var y=0; y<h; y++){ var so=y*bpr, di=y*w*4; for (var x=0; x<w*4; x++) dst[di+x] = src[so+x]; }
      ctx.putImageData(img, 0, 0);
      sc.convertToBlob().then(function(b){ return b.arrayBuffer(); }).then(function(ab){
        var u=new Uint8Array(ab), s=''; for (var i=0;i<u.length;i++) s+=String.fromCharCode(u[i]);
        self.postMessage({ __frame: btoa(s), __count: count, __w: w, __h: h });
      }).catch(function(e){ self.postMessage({ __frameErr: ''+e }); });
    } catch(e){ self.postMessage({ __frameErr: ''+e }); }
  }, 1000);
})();
`;

const PREAMBLE = `<script>
window.__doomFrame=null;
var OB = self.Blob;
self.Blob = function(parts, opts){
  try { if (opts && /javascript/.test(opts.type||'') && Array.isArray(parts)) parts = [${JSON.stringify(WORKER_SHIM)}].concat(parts); } catch(e){}
  return new OB(parts, opts);
};
self.Blob.prototype = OB.prototype;
var OW = self.Worker;
window.__cerr=[]; window.__count=0;
self.Worker = function(u,o){ var w=new OW(u,o); try{ w.addEventListener('message',function(e){ var d=e.data; if(!d) return; if(d.__frame){window.__doomFrame=d.__frame; window.__count=d.__count; window.__dim=d.__w+'x'+d.__h;} if(d.__shim){window.__shim=d;} if(d.__beat){window.__beat=d.__beat;} if(d.__cerr){window.__cerr.push(d.__cerr);} if(d.__frameErr){window.__frameErr=d.__frameErr;} }); }catch(e){} return w; };
self.Worker.prototype = OW.prototype;
</script>`;

const src = fs.readFileSync(path.join(WWW, 'doom.html'), 'utf8');
const i = src.indexOf('<head>');
fs.writeFileSync(path.join(WWW, 'doom-extract.html'), src.slice(0, i + 6) + '\n' + PREAMBLE + '\n' + src.slice(i + 6));
log('built doom-extract.html');

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore','pipe','pipe'] });
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
for (let k=0;k<50;k++){ try{ if((await fetch(URL)).ok) break; }catch{} await sleep(100); }

let driver;
try {
  driver = await new Builder().forBrowser('safari').setSafariOptions(new Options().setPageLoadStrategy('eager')).build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 10000 });
  await driver.manage().window().setRect({ width: 820, height: 700 });
  log('opening ' + URL);
  try { await driver.get(URL); } catch (e) { log('get(): ' + e.message); }
  // Click "Click to Start".
  const end0 = Date.now() + 12000;
  while (Date.now() < end0) { if (await driver.executeScript("var o=document.getElementById('overlay'); if(o){o.click(); return true;} return false;").catch(()=>false)) { log('clicked #overlay'); break; } await sleep(400); }

  let saved = 0;
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const png = await driver.executeScript('var f=window.__doomFrame; window.__doomFrame=null; return f;').catch(() => null);
    if (png) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(png, 'base64')); saved++; if (saved <= 3 || saved % 5 === 0) log('saved frame #' + saved + ' (' + Buffer.from(png,'base64').length + ' bytes)'); }
    await sleep(1000);
  }
  const st = await driver.executeScript("return {cc:(function(){var c=document.getElementById('canvas-container');return !!c&&getComputedStyle(c).display!=='none';})(), status:(document.getElementById('status')||{}).textContent, shim:window.__shim, beat:window.__beat, count:window.__count, dim:window.__dim, cerr:(window.__cerr||[]).slice(-6), ferr:window.__frameErr}").catch(()=>({}));
  log(`shim=${JSON.stringify(st.shim)} writeTexture_count=${st.count} beat=${JSON.stringify(st.beat)} dim=${st.dim||'?'} frameErr=${st.ferr||'none'}`);
  if (st.cerr && st.cerr.length) log('worker console.error:\n  ' + st.cerr.join('\n  '));
  log(`canvas-container=${st.cc} status=${st.status} ; ${saved} frame(s) → ${OUT}`);
} catch (e) { log('FAILED: ' + e.message); process.exitCode = 1; }
finally { if (driver) { try { await driver.quit(); } catch {} } server.kill('SIGTERM'); log('done.'); }
