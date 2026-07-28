// 0385 round 2: split syscall cost vs spawn floor vs binary-init in Safari in-OS.
import { Builder } from 'selenium-webdriver';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3329;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT), '--strict-port', '--minimal'], { stdio: ['ignore', 'pipe', 'pipe'] });
const URL_ = `http://localhost:${PORT}/os/os.html?hostkeys=off`;
let driver;
try {
  for (let i = 0; i < 1200; i++) { try { const r = await fetch(URL_); if (r.ok) break; } catch {} await sleep(500); }
  driver = await new Builder().forBrowser('safari').build();
  await driver.get(URL_);
  for (let i = 0; ; i++) {
    const st = await driver.executeScript('return window.__osState');
    if (st === 'ready') break;
    if (i > 360) throw new Error('boot timeout state=' + st);
    await sleep(500);
  }
  for (let i = 0; ; i++) {
    if (/~ #/.test(await driver.executeScript('return window.__osOut || ""'))) break;
    if (i > 120) throw new Error('no prompt');
    await sleep(250);
  }
  await driver.executeScript('window.__osVtSwitch(1)');
  spawn('osascript', ['-e', 'tell application "Safari" to activate'], { stdio: 'ignore' });
  await sleep(1500);
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
    await driver.executeScript(`const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus();`);
    const el = await driver.switchTo().activeElement();
    await el.sendKeys(line + '\n');
  };
  let n = 0;
  async function timedSh(cmd, ms = 120000) {
    const go = `GO${n}Z`, dn = `DN${n}Z`; n++;
    await driver.executeScript('window.__watch.push(arguments[0], arguments[1])', go, dn);
    await typeInto(`echo ${go.slice(0, -1)}""Z; ${cmd}; echo ${dn.slice(0, -1)}""Z-RC=$?`);
    const end = Date.now() + ms;
    for (;;) {
      const marks = await driver.executeScript('return window.__marks');
      if (marks[dn] !== undefined && marks[go] !== undefined) return Math.round(marks[dn] - marks[go]);
      if (Date.now() > end) throw new Error('timeout: ' + cmd);
      await sleep(100);
    }
  }
  async function bench(name, cmd, reps = 5) {
    const xs = [];
    for (let i = 0; i < reps; i++) xs.push(await timedSh(cmd));
    const s2 = xs.slice().sort((a, b) => a - b);
    console.log(`  ${name.padEnd(26)} p50=${s2[Math.floor(s2.length / 2)]}ms all=[${xs.join(',')}]`);
  }
  console.log('== Safari in-OS round 2 ==');
  await bench('builtin_noop', ':');
  await bench('builtin_redirect', 'echo x > /root/p');
  await bench('spawn_true_path', '/bin/true');
  await bench('spawn_realpath', 'realpath /bin/sh >/dev/null');
  await bench('spawn_sh_c', 'sh -c :');
  await bench('spawn_sh_c_again', 'sh -c :');
} catch (e) { console.error('ERROR: ' + (e && e.message)); process.exitCode = 1; }
finally { try { if (driver) await driver.quit(); } catch {}; server.kill(); }
