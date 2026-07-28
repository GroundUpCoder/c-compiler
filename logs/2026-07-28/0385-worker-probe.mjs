// 0385: per-spawn cost attribution in Safari vs Chromium.
//  bare        trivial blob worker → first message
//  hostjs      worker importScripts('/host.js') → first message
//  compileMain WebAssembly.compile of py.wasm on the main thread
//  cloneInst   postMessage(precompiled Module) to worker → instantiate there
//  bytesInst   postMessage(bytes) to worker → compile+instantiate there
// Usage: node logs/2026-07-28/0385-worker-probe.mjs safari|chromium
import { Builder } from 'selenium-webdriver';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3321;
const MODE = process.argv[2] || 'safari';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT), '--strict-port', '--minimal'],
  { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitServer(url) {
  for (let i = 0; i < 600; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('server never came up');
}

// A worker body that instantiates whatever arrives (Module or bytes) with
// stub imports built from Module.imports, then reports ms back.
const INST_WORKER = `
  onmessage = async (e) => {
    const t0 = performance.now();
    let mod = e.data;
    if (mod instanceof ArrayBuffer || ArrayBuffer.isView(mod)) {
      mod = await WebAssembly.compile(mod);
    }
    const imp = {};
    for (const d of WebAssembly.Module.imports(mod)) {
      imp[d.module] = imp[d.module] || {};
      if (d.kind === 'function') imp[d.module][d.name] = () => 0;
      else if (d.kind === 'global') imp[d.module][d.name] = 0;
      else if (d.kind === 'memory') imp[d.module][d.name] = new WebAssembly.Memory({ initial: 1 });
      else if (d.kind === 'table') imp[d.module][d.name] = new WebAssembly.Table({ initial: 1, element: 'anyfunc' });
    }
    try { await WebAssembly.instantiate(mod, imp); } catch (err) { /* start trap ok */ }
    postMessage(performance.now() - t0);
  };
`;

const PROBE_FN = `async (cb) => {
  try {
    const out = {};
    const mk = (src) => new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const runBare = () => new Promise((res) => {
      const t0 = performance.now();
      const w = mk('postMessage(1)');
      w.onmessage = () => { res(performance.now() - t0); w.terminate(); };
    });
    out.bare = [];
    for (let i = 0; i < 5; i++) out.bare.push(await runBare());
    const runHost = () => new Promise((res) => {
      const t0 = performance.now();
      const w = mk('importScripts(location.origin.replace("blob:","") + "/host.js"); postMessage(1)');
      w.onmessage = () => { res(performance.now() - t0); w.terminate(); };
    });
    out.hostjs = [];
    for (let i = 0; i < 5; i++) out.hostjs.push(await runHost());

    const bytes = await (await fetch('/tmp-0385/py.wasm')).arrayBuffer();
    out.compileMain = [];
    let mod;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      mod = await WebAssembly.compile(bytes.slice(0));
      out.compileMain.push(performance.now() - t0);
    }
    const instWorker = ${JSON.stringify(INST_WORKER)};
    const runInst = (payload) => new Promise((res) => {
      const w = mk(instWorker);
      const t0 = performance.now();
      w.onmessage = (e) => { res({ total: performance.now() - t0, inner: e.data }); w.terminate(); };
      w.postMessage(payload);
    });
    out.cloneInst = []; out.cloneInstInner = [];
    for (let i = 0; i < 3; i++) {
      const r = await runInst(mod);
      out.cloneInst.push(r.total); out.cloneInstInner.push(r.inner);
    }
    out.bytesInst = []; out.bytesInstInner = [];
    for (let i = 0; i < 3; i++) {
      const r = await runInst(bytes.slice(0));
      out.bytesInst.push(r.total); out.bytesInstInner.push(r.inner);
    }
    cb(JSON.stringify(out));
  } catch (e) {
    cb(JSON.stringify({ error: String(e && e.message || e) }));
  }
}`;

let driver, browser;
try {
  const url = `http://localhost:${PORT}/tests/browser/www/oc-probe.html`;
  await waitServer(url);
  let result;
  if (MODE === 'safari') {
    driver = await new Builder().forBrowser('safari').build();
    await driver.get(url);
    spawn('osascript', ['-e', 'tell application "Safari" to activate'], { stdio: 'ignore' });
    await sleep(1000);
    await driver.manage().setTimeouts({ script: 300000 });
    result = await driver.executeAsyncScript(`(${PROBE_FN})(arguments[arguments.length - 1])`);
  } else {
    process.env.CC_NO_PLAYWRIGHT_PIN = '1';
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);
    result = await page.evaluate(`new Promise((r) => (${PROBE_FN})(r))`);
  }
  const r = JSON.parse(result);
  if (r.error) throw new Error('probe: ' + r.error);
  for (const [k, xs] of Object.entries(r)) {
    console.log(`  ${MODE} ${k.padEnd(14)} ${xs.map((x) => x.toFixed(0)).join(',')} ms`);
  }
} catch (e) {
  console.error('ERROR: ' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { if (driver) await driver.quit(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  server.kill();
}
