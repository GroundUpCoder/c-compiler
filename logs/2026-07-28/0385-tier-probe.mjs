// Does a structured-cloned WebAssembly.Module carry warm code across workers?
// A compute loop (fib) runs in worker1, then the SAME cloned module in worker2.
// If the engine shares compiled code, w2 ≈ w1-warm; if per-agent, w2 re-pays.
import { Builder } from 'selenium-webdriver';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3327;
const MODE = process.argv[2] || 'safari';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT), '--strict-port', '--minimal'], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = `http://localhost:${PORT}/tests/browser/www/oc-probe.html`;

// wat: fib(n) recursive — enough code+calls to see tier effects
// (module (func $fib (param i32) (result i32) ...) (export "fib"))
// hand-assembled minimal binary via wat2wasm offline is overkill; build bytes in JS:
const PROBE_FN = `async (cb) => {
  try {
    // tiny wasm: recursive fib
    const bytes = new Uint8Array([
      0,97,115,109,1,0,0,0,
      1,6,1,96,1,127,1,127,          // type (i32)->i32
      3,2,1,0,                        // func 0
      7,7,1,3,102,105,98,0,0,        // export "fib"
      10,31,1,29,0,                   // code
      32,0,65,2,72,4,64,32,0,15,11,  // if n<2 return n
      32,0,65,1,107,16,0,32,0,65,2,107,16,0,106,15,11
    ]);
    const mod = await WebAssembly.compile(bytes);
    const workerSrc = \`
      onmessage = async (e) => {
        const inst = await WebAssembly.instantiate(e.data);
        const runs = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          inst.exports.fib(32);
          runs.push(performance.now() - t0);
        }
        postMessage(runs);
      };
    \`;
    const runIn = () => new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
      w.onmessage = (e) => { res(e.data); w.terminate(); };
      w.postMessage(mod);
    });
    const w1 = await runIn();
    const w2 = await runIn();
    const w3 = await runIn();
    cb(JSON.stringify({ w1, w2, w3 }));
  } catch (e) { cb(JSON.stringify({ error: String(e && e.message || e) })); }
}`;
let driver, browser;
try {
  for (let i = 0; i < 600; i++) { try { const r = await fetch(url); if (r.ok) break; } catch {} await sleep(500); }
  let result;
  if (MODE === 'safari') {
    driver = await new Builder().forBrowser('safari').build();
    await driver.get(url);
    spawn('osascript', ['-e', 'tell application "Safari" to activate'], { stdio: 'ignore' });
    await sleep(1000);
    await driver.manage().setTimeouts({ script: 120000 });
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
  if (r.error) throw new Error(r.error);
  for (const k of ['w1','w2','w3']) console.log(`  ${MODE} ${k} fib(32) runs: ${r[k].map((x)=>x.toFixed(1)).join(', ')} ms`);
} catch (e) { console.error('ERROR: ' + (e && e.message)); process.exitCode = 1; }
finally { try { if (driver) await driver.quit(); } catch {}; try { if (browser) await browser.close(); } catch {}; server.kill(); }
