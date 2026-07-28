// Nested-worker cost: worker spawned FROM a worker (the gucOS kernel-worker shape).
import { Builder } from 'selenium-webdriver';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3323;
const MODE = process.argv[2] || 'safari';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT), '--strict-port', '--minimal'], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = `http://localhost:${PORT}/tests/browser/www/oc-probe.html`;
const PROBE_FN = `async (cb) => {
  try {
    // outer worker creates inner blob workers and reports each round-trip ms
    const outerSrc = \`
      const mk = (src) => new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      onmessage = async () => {
        const xs = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await new Promise((res) => { const w = mk('postMessage(1)'); w.onmessage = () => { res(); w.terminate(); }; });
          xs.push(performance.now() - t0);
        }
        postMessage(xs);
      };
    \`;
    const w = new Worker(URL.createObjectURL(new Blob([outerSrc], { type: 'text/javascript' })));
    const xs = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(1); });
    w.terminate();
    cb(JSON.stringify({ nested: xs }));
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
  console.log(`  ${MODE} nested-worker rtt: ${r.nested.map((x) => x.toFixed(0)).join(',')} ms`);
} catch (e) { console.error('ERROR: ' + (e && e.message)); process.exitCode = 1; }
finally { try { if (driver) await driver.quit(); } catch {}; try { if (browser) await browser.close(); } catch {}; server.kill(); }
