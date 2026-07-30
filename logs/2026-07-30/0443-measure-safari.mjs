// #188 (0443) acceptance 2: warm `python --version` p50 on REAL desktop
// Safari (safaridriver), minimal image + gucman install — the 0385 harness
// (logs/2026-07-28/0385-measure-safari.mjs) re-run against the landed
// rw-volume module cache. Target: warm p50 ≤ 210 ms (parity with 0385's
// 151 ms throwaway-edit experiment plus noise; the pre-fix baseline was
// 645 ms).
// Timing is IN-PAGE (an __osOut setter stamps performance.now() at tty
// delivery), so selenium round-trips and Safari's occluded-window timer
// throttling don't pollute the numbers.
// Usage: node logs/2026-07-30/0443-measure-safari.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
// selenium-webdriver lives in tests/browser's package (the safari-renders
// toolchain), not at the repo root.
const req = createRequire(path.join(ROOT, 'tests', 'browser', 'x.js'));
const { Builder } = req('selenium-webdriver');

const PORT = 3341;
const URL = `http://localhost:${PORT}/os/os.html?hostkeys=off`;
const log = (s) => process.stderr.write(`[safari] ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT), '--strict-port', '--minimal'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stderr.write('[serve] ' + d));

async function waitServer() {
  for (let i = 0; i < 1800; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('serve.js never came up');
}

let driver;
try {
  await waitServer();
  log('server up; starting safari');
  driver = await new Builder().forBrowser('safari').build();
  await driver.get(URL);

  const bootT0 = Date.now();
  for (let i = 0; ; i++) {
    const st = await driver.executeScript('return window.__osState');
    if (st === 'ready') break;
    if (st === 'nogpu') throw new Error('boot-nogpu: Safari worker WebGPU unavailable');
    if (st === 'locked') throw new Error('boot-locked');
    if (i > 360) throw new Error('boot timeout, state=' + st);
    await sleep(500);
  }
  log(`boots to ready in ${Date.now() - bootT0}ms`);
  for (let i = 0; ; i++) {
    if (/~ #/.test(await driver.executeScript('return window.__osOut || ""'))) break;
    if (i > 120) throw new Error('no shell prompt');
    await sleep(250);
  }
  await driver.executeScript('window.__osVtSwitch(1)');
  // Foreground the window: an occluded Safari throttles timers and rAF, and
  // the iPhone scenario is a foreground tab anyway.
  spawn('osascript', ['-e', 'tell application "Safari" to activate'], { stdio: 'ignore' });
  await sleep(1500);

  // Throttle-immune marker stamping (the 0385 trick): stamp watch markers
  // synchronously at __osOut assignment time.
  await driver.executeScript(`
    (function () {
      let cur = window.__osOut;
      window.__watch = []; window.__marks = {};
      Object.defineProperty(window, '__osOut', {
        get() { return cur; },
        set(v) {
          cur = v;
          for (const m of window.__watch) {
            if (!(m in window.__marks) && v.includes(m)) window.__marks[m] = performance.now();
          }
        },
        configurable: true,
      });
    })();
  `);

  const typeInto = async (line) => {
    await driver.executeScript(`
      const ta = document.querySelector('.xterm-helper-textarea');
      if (ta) ta.focus();
    `);
    const el = await driver.switchTo().activeElement();
    await el.sendKeys(line + '\n');
  };

  let n = 0;
  async function timedSh(cmd, ms = 300000) {
    const go = `GO${n}Z`, dn = `DN${n}Z`; n++;
    await driver.executeScript('window.__watch.push(arguments[0], arguments[1])', go, dn);
    // marker split in the TYPED text so input echo can't satisfy the watch
    await typeInto(`echo ${go.slice(0, -1)}""Z; ${cmd}; echo ${dn.slice(0, -1)}""Z-RC=$?`);
    const end = Date.now() + ms;
    for (;;) {
      const marks = await driver.executeScript('return window.__marks');
      if (marks[dn] !== undefined && marks[go] !== undefined) return Math.round(marks[dn] - marks[go]);
      if (Date.now() > end) throw new Error('timeout waiting for ' + dn + ' after: ' + cmd);
      await sleep(100);
    }
  }

  const p50 = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  async function bench(name, cmd, reps = 5) {
    const xs = [];
    for (let i = 0; i < reps; i++) xs.push(await timedSh(cmd));
    console.log(`  ${name.padEnd(30)} p50=${p50(xs)}ms all=[${xs.join(',')}]`);
    return xs;
  }

  console.log('== #188 acceptance 2: REAL Safari, minimal image + gucman install ==');
  const probe = await timedSh(':', 15000);
  console.log(`  input probe: ${probe}ms`);
  const inst = await timedSh('gucman install cpython-clang >/dev/null 2>&1', 300000);
  console.log(`  gucman install cpython-clang: ${inst}ms`);

  // Cold rep first (compile miss — reported, not part of the warm p50),
  // then the warm distribution the acceptance arm is about.
  const cold = await timedSh('python --version >/dev/null 2>&1');
  console.log(`  pyv cold (first spawn):        ${cold}ms`);
  const warm = await bench('pyv WARM (acceptance arm)', 'python --version >/dev/null 2>&1', 9);
  console.log(`  ==> warm python --version p50 = ${p50(warm)}ms (target <= 210ms)`);
  await bench('pass_dispatcher', 'python -c pass >/dev/null 2>&1', 5);
  await bench('true_applet', 'true', 5);
  console.log('done');
} catch (e) {
  console.error('ERROR: ' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { if (driver) await driver.quit(); } catch {}
  server.kill();
}
