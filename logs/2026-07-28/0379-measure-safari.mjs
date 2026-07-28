// 0379: REAL Safari (safaridriver) end-to-end command latency on the minimal
// image + gucman install — closest desktop proxy for the iPhone path.
// Timing is IN-PAGE (rAF poller stamps performance.now() when tty markers
// appear), so selenium round-trips don't pollute the numbers.
// Usage: node tmp-0379/measure-safari.mjs
import { Builder } from 'selenium-webdriver';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3317;
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

  // boot to ready
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
  // shell prompt
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

  // Throttle-immune marker stamping: intercept every __osOut assignment and
  // stamp watch markers synchronously at delivery time (an occluded Safari
  // window throttles timers/rAF, so a polling loop reads garbage there).
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
    // Focus the terminal first (Safari won't route keys to the hidden xterm
    // textarea without focus), then type via the focused element.
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

  async function bench(name, cmd, reps = 5) {
    const xs = [];
    for (let i = 0; i < reps; i++) xs.push(await timedSh(cmd));
    const s2 = xs.slice().sort((a, b) => a - b);
    console.log(`  ${name.padEnd(30)} p50=${s2[Math.floor(s2.length / 2)]}ms all=[${xs.join(',')}]`);
  }

  console.log('== REAL Safari (minimal image + gucman install) ==');
  // input-path probe first: a cheap echo with a short timeout + tty tail dump
  try {
    const probe = await timedSh(':', 15000);
    console.log(`  input probe: ${probe}ms`);
  } catch (e) {
    const tail = await driver.executeScript('return (window.__osOut || "").slice(-300)');
    const st = await driver.executeScript('return JSON.stringify({watch: window.__watch, marks: window.__marks, raf: window.__rafTicks})');
    console.error('input probe failed; tty tail: ' + JSON.stringify(tail) + ' state=' + st);
    throw e;
  }
  const inst = await timedSh('gucman install python-clang >/dev/null 2>&1', 300000);
  console.log(`  gucman install: ${inst}ms`);

  if (process.env.FIXLAUNCHER) {
    // Replace the launcher's $(dirname $(realpath $0)) chain (4 extra spawns)
    // with a spawn-free known-prefix exec — the candidate fix.
    await timedSh('printf \'#!/bin/sh\\nPYTHONPYCACHEPREFIX=/var/cache/python-clang\\nexport PYTHONPYCACHEPREFIX\\nexec /opt/python-clang/bin/python-clang.wasm "$@"\\n\' > /opt/python-clang/bin/python-clang');
    console.log('  (launcher replaced with spawn-free version)');
  }

  await bench('true_applet', 'true');
  await bench('sh_c_colon', 'sh -c :');
  await bench('pyv_wasm_direct', '/opt/python-clang/bin/python-clang.wasm --version >/dev/null 2>&1');
  await bench('pyv_launcher', 'python-clang --version >/dev/null 2>&1');
  await bench('pyv_dispatcher', 'python --version >/dev/null 2>&1');
  await bench('pass_direct', '/opt/python-clang/bin/python-clang.wasm -c pass >/dev/null 2>&1', 3);
  await bench('pass_dispatcher', 'python -c pass >/dev/null 2>&1', 3);
  console.log('done');
} catch (e) {
  console.error('ERROR: ' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { if (driver) await driver.quit(); } catch {}
  server.kill();
}
