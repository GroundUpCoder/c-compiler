// 0004 acceptance, browser half: boot the reference OS page (os/os.html) in
// headless Chromium and drive the protoshell through the real xterm input
// path — keystrokes -> kernel worker -> tty line discipline -> pid 1.
//
// Serves the REPO ROOT with serve.js (COOP/COEP for SAB), so the page loads
// host.js/kernel.js/compiler.js exactly as a developer's `node serve.js .`
// session would. Asserts: boot reaches the shell over a fresh OPFS image,
// `ls /` lists the seeded tree, `cc hello.c && ./a.out` compiles and runs
// in-OS, vi edits a file through the xterm keyboard path (todos/0011 —
// deep edit scenarios live in tests/kernel/test_vi_e2e.js), and a reload
// REUSES the persisted image (a.out survives).
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

  // -1: busybox ls (todos/0010) prints columns on a tty; one-per-line keeps
  // the needle stable. Program stdout is raw \n (no OPOST).
  await type('ls -1 /');
  await waitOut('bin\ndev\netc\nroot');
  check('ls -1 / lists the seeded tree', true);

  await type('cc hello.c && ./a.out');
  await waitOut('hello, wasm world', 120000);
  check('cc hello.c && ./a.out runs in-browser', true);

  // vi (todos/0011): the full-screen editor through the REAL xterm path —
  // keystrokes -> xterm -> kernel tty (raw mode) -> vi; file bytes asserted
  // after :wq. Deep edit scenarios live in tests/kernel/test_vi_e2e.js; this
  // proves the browser half. ESC goes via press() with air around it
  // (read_key resolves a lone ESC by timeout).
  await type('vi /tmp/b.txt');
  await waitOut('\x1b[?1049h');              // vi entered the alternate screen
  await waitOut('- /tmp/b.txt');             // status line: first full draw done,
                                             // raw mode live — now safe to type
                                             // (the echoed command was "vi /tmp/…",
                                             // so "- /tmp/…" is unambiguous)
  await page.keyboard.type('ibrowser vi works');
  // No text needle here: Playwright types char-by-char, so each char is its
  // own tty read -> own refresh -> cursor-positioned single-char render; the
  // typed string never appears contiguously. The file bytes below are the
  // real assertion.
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.type(':wq\r');
  await waitOut('\x1b[?1049l');              // vi exited the alternate screen
  await type('cat /tmp/b.txt && echo VI-CAT-OK');
  await waitOut('VI-CAT-OK');
  const viSeg = await page.evaluate(() => {
    const out = window.__osOut;
    const exit = out.lastIndexOf('\x1b[?1049l');   // only trust post-vi output
    return out.slice(exit).replace(/\r/g, '');
  });
  check('vi edits a file through xterm (todos/0011)',
    viSeg.includes('browser vi works\n'), JSON.stringify(viSeg.slice(0, 300)));

  // Reboot the tab: same context = same OPFS; the image must be reused and
  // the compiled a.out must still be there.
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready',
    { timeout: 120000, polling: 250 });
  const mode = await page.evaluate(() => document.getElementById('status').textContent);
  // 0040 mode string: <system>/<root> — blob reused + existing v4 root volume.
  check('second boot reuses the image', /image: reused\/v4/.test(mode), mode);
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
