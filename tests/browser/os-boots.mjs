// 0004 acceptance, browser half: boot the reference OS page (os/os.html) in
// headless Chromium and drive the protoshell through the real xterm input
// path — keystrokes -> kernel worker -> tty line discipline -> pid 1.
//
// Serves the REPO ROOT with serve.js (COOP/COEP for SAB), so the page loads
// host.js/kernel.js/compiler.js exactly as a developer's `node serve.js .`
// session would. Asserts: boot reaches the shell over a fresh OPFS image,
// `ls /` lists the seeded tree, `cc hello.c && ./a.out` compiles and runs
// in-OS, and a reload REUSES the persisted image (a.out survives).
//
// Usage: node os-boots.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3179;
const URL = `http://localhost:${PORT}/os/os.html`;

function startServer() {
  const child = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stderr.write('[serve] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[serve] ' + d));
  return child;
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up at ' + URL);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const server = startServer();
const browser = await chromium.launch();
try {
  await waitForServer();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  // Fresh OPFS every run: Playwright contexts start with empty storage, so
  // the first load is always a first boot (seeding), the reload a re-mount.
  await page.goto(URL);

  // polling: interval — the default RAF polling can stall in an unfocused
  // headless page, missing updates that arrive between frames.
  const waitOut = async (needle, timeoutMs) => {
    await page.waitForFunction(
      (n) => window.__osOut && window.__osOut.includes(n), needle,
      { timeout: timeoutMs || 60000, polling: 250 });
  };
  const type = async (line) => { await page.keyboard.type(line + '\r'); };

  // Boot: seeding compiles protoshell + cc in the kernel worker (slow-ish).
  await page.waitForFunction(() => window.__osState === 'ready',
    { timeout: 120000, polling: 250 });
  check('boots to ready over OPFS', true);
  await waitOut('# ');                       // the prompt echoes through the tty

  await type('ls /');
  await waitOut('bin\ndev\netc\nroot');   // program stdout is raw \n (no OPOST)
  check('ls / lists the seeded tree', true);

  await type('cc hello.c && ./a.out');
  await waitOut('hello, wasm world', 120000);
  check('cc hello.c && ./a.out runs in-browser', true);

  // Reboot the tab: same context = same OPFS; the image must be reused and
  // the compiled a.out must still be there.
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready',
    { timeout: 120000, polling: 250 });
  const mode = await page.evaluate(() => document.getElementById('status').textContent);
  check('second boot reuses the image', /image: v4/.test(mode), mode);
  await type('ls');
  await waitOut('a.out');
  check('a.out persisted across reload', true);

  await type('exit 3');
  await page.waitForFunction(() => window.__osState === 'halted:3',
    { timeout: 30000, polling: 250 });
  check('halt reaches the page with the exit code', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos boots (browser): PASS' : `\nos boots (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
