// 0004 acceptance, browser half: boot the reference OS page (os/os.html) in
// headless Chromium and drive the desktop/terminal through the real input
// path — keystrokes -> kernel worker -> tty line discipline -> pid 1.
//
// Serves the REPO ROOT with serve.js (COOP/COEP for SAB), so the page loads
// host.js/kernel.js/compiler.js exactly as a developer's `node serve.js .`
// session would. Asserts: boot reaches the shell over a fresh OPFS image,
// `ls /` lists the seeded tree, `cc hello.c && ./a.out` compiles and runs
// in-OS, vi edits a file through the xterm keyboard path (todos/0011 —
// deep edit scenarios live in tests/kernel/test_vi_e2e.js), a reload
// REUSES the persisted image (a.out survives), and a WebGPU-disabled
// browser hits the loud boot-nogpu guard (todos/0055 — no fallback).
//
// Usage: node os-boots.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osUrl } from './lib/os-harness.mjs';

const PORT = 3179;
const URL = osUrl(PORT);

// os-boots streams serve output prefixed `[serve]` (a boot-debugging aid the
// rest of the sweep doesn't bother with) — the harness startServer taps stdio
// only when handed an onLog.
const server = startServer(PORT, { onLog: (d) => process.stderr.write('[serve] ' + d) });
// os-boots prints the FAIL `extra` raw (not JSON.stringified) — its extras are
// already strings (mode lines, VT segments).
const { check, state } = makeCheck({ stringify: false });
// WebGPU flags: since todos/0055 the OS boot REQUIRES a worker WebGPU
// device (the compositor has no Canvas2D fallback) — same flags as the
// rest of the os-*.mjs sweep. The no-GPU guard leg below launches its own
// flag-disabled browser to assert the boot-nogpu screen.
const browser = await launchBrowser();
try {
  await waitForServer(URL);
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

  // Boot: seeding compiles cc and the image projects in the kernel worker (slow-ish).
  await page.waitForFunction(() => window.__osState === 'ready',
    { timeout: 120000, polling: 250 });
  check('boots to ready over OPFS', true);
  // 0070: a healthy boot auto-switches to the Desktop tab; the shell legs
  // below type through xterm, so hop back to VT1 first.
  check('healthy boot lands on the Desktop tab (todos/0070)',
    await page.evaluate(() => window.__osVt) === 2);
  await page.evaluate(() => window.__osVtSwitch(1));
  await waitOut('# ');                       // the prompt echoes through the tty

  // -1: busybox ls (todos/0010) prints columns on a tty; one-per-line keeps
  // the needle stable. Program stdout is raw \n (no OPOST).
  await type('ls -1 /');
  await waitOut('bin\ndev\netc\nproc\nroot');   // 0043: /proc in the tree
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
  await page.waitForTimeout(600);            // timing subject: char-by-char vi typing has no contiguous needle (see note above); let it land before ESC
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);            // timing subject: read_key resolves a lone ESC by timeout — air around it, no observable marker
  await page.keyboard.type(':wq\r');
  await waitOut('\x1b[?1049l');              // vi exited the alternate screen
  // Split needle (#356, 0171 class): the typed command's ECHO must not
  // contain the wait's needle, or the wait returns before cat's output
  // exists and viSeg below captures a truncated transcript. hush glues
  // the "" back together, so only the real `echo` output matches.
  await type('cat /tmp/b.txt && echo VI-CAT""-OK');
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
  // 0070: a manual VT choice made DURING boot must beat the ready auto-
  // switch. The old form raced ready — "if ready wins the race this degrades
  // to a plain post-ready switch and the check passes vacuously" — so on a
  // warm machine the leg tested nothing (#97/0287). Make the window
  // deterministic: intercept the __osState probe before the reloaded page's
  // scripts run and fire the USER VT switch synchronously inside the
  // 'booting' assignment itself (os.html defines __osVtSwitch before it sets
  // 'booting'). __vtGrabAt records the state the switch fired at — the check
  // below requires 'booting', so a post-ready switch can never pass again.
  // Gated on sessionStorage: the first boot above needed the auto-switch
  // (vtTouched unset) for its 'lands on the Desktop tab' leg.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('vtgrab') !== '1') return;
    let st;
    Object.defineProperty(window, '__osState', {
      configurable: true,
      get: () => st,
      set: (v) => {
        st = v;
        if (v === 'booting' && !window.__vtGrabAt && typeof window.__osVtSwitch === 'function') {
          window.__osVtSwitch(1);
          window.__vtGrabAt = v;
        }
      },
    });
  });
  await page.evaluate(() => sessionStorage.setItem('vtgrab', '1'));
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready',
    { timeout: 120000, polling: 250 });
  const grab = await page.evaluate(() =>
    ({ at: window.__vtGrabAt, vt: window.__osVt }));
  check('manual VT choice during boot survives ready (todos/0070)',
    grab.at === 'booting' && grab.vt === 1, JSON.stringify(grab));
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

  // Two-tab boot guard (todos/0045): a second tab in the SAME context (same
  // origin, same OPFS) must NOT boot a second kernel — the first tab's
  // worker still holds the Web Lock (halted != closed; the lock lives until
  // the tab dies). Closing the first tab frees it; the guard's Retry then
  // boots normally over the reused image.
  const page2 = await context.newPage();
  page2.on('console', (m) => { if (m.type() === 'error') process.stderr.write('[page2] ' + m.text() + '\n'); });
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__osState === 'locked',
    { timeout: 30000, polling: 250 });
  const guardShown = await page2.evaluate(() =>
    document.body.hasAttribute('data-guard') &&
    getComputedStyle(document.getElementById('guard')).display !== 'none' &&
    getComputedStyle(document.getElementById('terminal')).display === 'none');
  check('second tab hits the boot guard (todos/0045)', guardShown);

  await page.close();   // the winning tab dies -> the browser releases the lock
  // Retry until the release lands (close -> lock-free is not synchronous). A
  // still-held lock just answers boot-locked again; the worker ignores
  // retries while a boot is in flight, so over-clicking is harmless.
  const t0 = Date.now();
  let st = '';
  while (Date.now() - t0 < 120000) {
    st = await page2.evaluate(() => window.__osState);
    if (st === 'ready') break;
    if (st === 'locked') {
      await page2.evaluate(() => document.getElementById('guardRetry').click());
    }
    await page2.waitForTimeout(500);   // timing subject: retry-loop poll cadence (loop breaks on __osState==='ready')
  }
  check('retry boots after the first tab closes (todos/0045)', st === 'ready', st);
  const mode2 = await page2.evaluate(() => document.getElementById('status').textContent);
  check('the retried boot reuses the image', /image: reused\/v4/.test(mode2), mode2);
  await page2.evaluate(() => window.__osVtSwitch(1));   // 0070: ready landed on VT2
  await page2.evaluate(() => { window.__osOut = ''; });
  // Split needle (#356): same 0171 class as the vi leg — if the tty's
  // echo of the typed line renders the needle + newline, the wait is
  // satisfied before the command runs and proves nothing.
  await page2.keyboard.type('echo GUARD-SHELL""-OK\r');
  await page2.waitForFunction(
    () => window.__osOut.includes('GUARD-SHELL-OK\n'),
    { timeout: 30000, polling: 250 });
  check('the retried boot reaches a live shell', true);

  // WebGPU boot guard (todos/0055): a browser without worker WebGPU must
  // NOT boot — the compositor has no fallback, so the kernel worker stops
  // before mounting anything and the page shows the loud guard screen.
  // --disable-features=WebGPU makes requestAdapter deterministically null.
  const noGpuBrowser = await launchBrowser(['--disable-features=WebGPU']);
  try {
    const page3 = await (await noGpuBrowser.newContext()).newPage();
    await page3.goto(URL);
    await page3.waitForFunction(() => window.__osState === 'nogpu',
      { timeout: 60000, polling: 250 });
    const nogpuGuard = await page3.evaluate(() =>
      document.body.hasAttribute('data-guard') &&
      getComputedStyle(document.getElementById('guard')).display !== 'none' &&
      /WebGPU/.test(document.getElementById('guardMsg').textContent) &&
      getComputedStyle(document.getElementById('guardRetry')).display === 'none');
    check('no-WebGPU boot hits the boot-nogpu guard (todos/0055)', nogpuGuard);
  } finally {
    await noGpuBrowser.close();
  }
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos boots (browser): PASS' : `\nos boots (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
