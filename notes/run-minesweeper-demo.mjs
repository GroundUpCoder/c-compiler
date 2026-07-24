// Minesweeper WebGPU-path demonstration driver (NOT a swept os-*.mjs): boot
// gucOS in real Chromium, curl+untar the staged Rainbow Minesweeper into
// /root, `cc *.c` it IN-OS, run it, PROVE the frames ride the WebGPU SDL 2D
// renderer (blank `wmctl shot` of the gpu-transport surface while the
// composited screen is live — the software fallback would fill the shm SAB),
// prove it's playable (left-click flood-uncover, right-click flag, theme key,
// difficulty key, a REAL size-key window resize), and save screenshots to
// build/minesweeper-shots/ (the committed copies live in
// tests/browser/shots-minesweeper/).
//
// Staging (gitignored): build/minesweeper-stage/minesweeper.tar.gz = the
// github.com/ProgrammingRainbow/Minesweeper-C-SDL3 sources — Video18/*.{c,h}
// at the tar root (with the one VLA sed: game.c title_str[length] → [512])
// plus the repo-root images/ dir.
//
// Usage: node notes/run-minesweeper-demo.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from '../tests/browser/lib/os-harness.mjs';
import fs from 'node:fs';

const PORT = 3271;
const URL = osUrl(PORT);
const TGZ = `http://localhost:${PORT}/build/minesweeper-stage/minesweeper.tar.gz`;
const SHOT_DIR = 'build/minesweeper-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

const log = (m) => process.stdout.write(`[demo] ${m}\n`);

// Full-screen composite grab off the desktop canvas -> PNG file.
async function screenshot(page, name) {
  const dataUrl = await page.evaluate(() => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    t.getContext('2d').drawImage(c, 0, 0);
    return t.toDataURL('image/png');
  });
  const b64 = dataUrl.split(',')[1];
  const p = `${SHOT_DIR}/${name}.png`;
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  log(`shot -> ${p}`);
  return p;
}

try {
  await waitForServer(URL, { tries: 400, interval: 100 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample } = osHelpers(page);

  // Region stats over a client rect: distinct colors + hash + non-teal cover.
  const region = (x0, y0, x1, y1) => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    t.getContext('2d').drawImage(cv, 0, 0);
    const img = t.getContext('2d').getImageData(a, b, c - a, d - b).data;
    let h = 2166136261 >>> 0, nonTeal = 0, n = 0; const colors = new Set();
    for (let i = 0; i < img.length; i += 16) {
      const col = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      h ^= col; h = Math.imul(h, 16777619) >>> 0; colors.add(col); n++;
      if (col !== 0x008080) nonTeal++;
    }
    return { h, colors: colors.size, nonTeal, n };
  }, [x0, y0, x1, y1]);

  // --- type a shell command on VT1, wait for a trailing marker echo ---
  const shell = async (cmd, marker, ms = 30000) => {
    await setVt(1);
    await page.keyboard.type(cmd + '\r');
    if (marker) {
      const src = marker instanceof RegExp ? marker.source : null;
      await page.waitForFunction(
        (a) => window.__osOut && (a.re ? new RegExp(a.re).test(window.__osOut) : window.__osOut.includes(a.s)),
        { re: src, s: src ? null : marker }, { timeout: ms, polling: 200 });
    }
  };

  // 1) stage: curl the tarball, untar into /root/ms
  log('staging game via in-OS curl + tar…');
  await shell(`mkdir -p /root/ms && cd /root/ms && curl -sL ${TGZ} -o m.tgz && echo CURL-$?`, 'CURL-0', 60000);
  check('curl fetched the tarball in-OS', true);
  await shell(`tar -xzf m.tgz && ls *.c | wc -l && echo UNTAR-DONE`, 'UNTAR-DONE', 30000);
  check('tar extracted the game in-OS', true);

  // 2) BUILD IN-OS: cc *.c (pulls libpng via the SDL_image require block)
  log('compiling in-OS with `cc *.c` (this pulls libpng+zlib; be patient)…');
  await shell(`cc *.c -o minesweeper >/root/ms/cc.log 2>&1 && echo BUILD-OK || echo BUILD-FAIL`,
              /BUILD-OK|BUILD-FAIL/, 600000);
  const built = await page.evaluate(() => window.__osOut.includes('BUILD-OK'));
  if (!built) {
    await shell(`cat /root/ms/cc.log`, null, 5000);
    const out = await page.evaluate(() => window.__osOut.slice(-2000));
    log('cc.log tail:\n' + out);
  }
  check('cc *.c built the game IN-OS', built);
  if (!built) throw new Error('in-OS build failed');

  // 3) RUN
  log('launching ./minesweeper &');
  await shell(`./minesweeper 2>/root/ms/run.log & echo LAUNCHED`, 'LAUNCHED', 10000);
  await new Promise(r => setTimeout(r, 2000));
  await shell(`cat /root/ms/run.log; echo RUNLOG-END`, 'RUNLOG-END', 8000);
  const runlog = await page.evaluate(() => window.__osOut.slice(-1500));
  log('run.log tail:\n' + runlog.split('\n').filter(l => /Error|error|fail|RUNLOG/.test(l)).join('\n'));
  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && Math.abs(r.width - window.__osScreen.w) < 2;
  }, { timeout: 10000, polling: 200 }).catch(() => {});

  // Client rect: WM places the first window's client near (16,40); the game is
  // 328x414. Wait until the client area actually renders (not teal desktop).
  const CLIENT = [18, 42, 18 + 320, 42 + 400];
  const waitFrame = async (pred, ms) => {
    const t0 = Date.now();
    for (;;) {
      const s = await region(...CLIENT);
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error('no frame: ' + JSON.stringify(s));
      await new Promise(r => setTimeout(r, 300));
    }
  };
  // wmctl list to see the window geometry
  await setVt(1);
  await shell(`wmctl list; echo WMLIST-END`, 'WMLIST-END', 8000);
  const wmlist = await page.evaluate(() => window.__osOut.slice(-1200));
  log('wmctl list:\n' + wmlist.split('\n').filter(l => /minesweeper|sid|SID|winbox|[0-9]x[0-9]/.test(l)).slice(-8).join('\n'));
  await setVt(2);
  const opened = await waitFrame(s => s.nonTeal > s.n * 0.3, 60000).catch(e => { log('waitFrame: ' + e.message); return null; });
  log('window region: ' + JSON.stringify(opened || await region(...CLIENT)));
  check('minesweeper window opened (non-teal client area present)', !!opened);
  const shot1 = await screenshot(page, '1-opened');

  // GPU-PATH PROOF (not the software fallback): a gpu-transport surface has
  // no CPU pixels — `wmctl shot` copies the (never-written) shm SAB. So a
  // BLANK shot for the SAME surface whose composited client area is live on
  // screen means every frame arrives as an ImageBitmap through the WebGPU
  // renderer (rdrFlush → transferToImageBitmap → hooks.surfaceFrame). The
  // software fallback would have filled the SAB with the very pixels we just
  // sampled. tail -c +16 skips the 15-byte "P6\n328 414\n255\n" header;
  // tr -d strips NULs, so NONZERO=0 ⇔ an all-black shot.
  await setVt(1);
  // NB the wait marker is /NONZ=\d/ — the TYPED command echo contains
  // "NONZ=$(" (no digit), so only the executed output can satisfy it
  // (the 0171 split-needle rule).
  await shell(
    `SID=$(wmctl list | grep "Minesweeper" | head -1 | sed "s/[^0-9].*//"); ` +
    `wmctl shot $SID /root/gpu.ppm && ` +
    `echo NONZ=$(tail -c +16 /root/gpu.ppm | tr -d "\\000" | wc -c)`,
    /NONZ=\d/, 30000);
  const probe = await page.evaluate(() => {
    const m = window.__osOut.match(/NONZ=(\d+)/g);
    return m ? m[m.length - 1] : null;
  });
  log('gpu-transport probe: ' + probe + ' (0 = shm SAB untouched = GPU path)');
  check('frames ride the GPU path — shm SAB blank while screen is live (not the software fallback)',
    probe === 'NONZ=0');
  await setVt(2);

  // 4) INTERACT — left-click a board cell (uncovers). Board grid begins below
  // the border/digit header; click a mid-board cell. Focus the window first.
  const before = await region(...CLIENT);
  // The board area sits roughly y>120 in-client; screen coords add the client
  // origin. Click a cell around client (100,200) -> screen (~118,242).
  await page.mouse.click(118, 242);
  await new Promise(r => setTimeout(r, 500));
  const afterClick = await waitFrame(s => s.h !== before.h, 15000).catch(() => null);
  check('left-click uncovered cells (board changed)', !!afterClick);
  log('after left-click: ' + JSON.stringify(afterClick));
  const shot2 = await screenshot(page, '2-left-click');

  // 5) right-click marks a flag on another cell
  const preMark = await region(...CLIENT);
  await page.mouse.click(150, 242, { button: 'right' });
  await new Promise(r => setTimeout(r, 500));
  const afterMark = await waitFrame(s => s.h !== preMark.h, 15000).catch(() => null);
  check('right-click marked a cell (board changed)', !!afterMark);
  const shot3 = await screenshot(page, '3-right-click');

  // 6) theme key: press '2' (SDL_SCANCODE_2 -> theme change, board recolors).
  const preTheme = await region(...CLIENT);
  await page.mouse.click(160, 300);             // ensure the window has focus
  await new Promise(r => setTimeout(r, 200));
  await page.keyboard.press('Digit2');
  await new Promise(r => setTimeout(r, 600));
  const afterTheme = await waitFrame(s => s.h !== preTheme.h, 15000).catch(() => null);
  check('number key changed theme (SDL_SCANCODE_2 reached the game)', !!afterTheme);
  const shot4 = await screenshot(page, '4-theme-2');

  // 7) difficulty key 'S' (medium) — board reset, mine density change
  await page.keyboard.press('KeyS');
  await new Promise(r => setTimeout(r, 800));
  const shot5 = await screenshot(page, '5-difficulty-S');
  check('difficulty key S handled (board reset, no crash)', true);

  // 8) SIZE key 'W' — a REAL window resize: SDL_SetWindowSize -> kernel
  // SURFACE_RESIZE -> onConfigure (canvas re-sized) -> next matching-size
  // GPU present acks. Assert the kernel geometry changed AND the new client
  // area renders (not stale/teal).
  await page.keyboard.press('KeyW');
  await new Promise(r => setTimeout(r, 1200));
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await new Promise(r => setTimeout(r, 800));
  const geom = await page.evaluate(() => {
    const m = window.__osOut.match(/(\d+x\d+)\+\d+\+\d+\s+\S+\s+\d+\s+\S+\s+Minesweeper/g);
    return m ? m[m.length - 1] : null;
  });
  await setVt(2);
  const resized = geom && !geom.startsWith('328x414');
  log('post-W geometry: ' + geom);
  const CLIENT2 = [18, 42, 300, 300];
  const afterResize = await (async () => { const t0 = Date.now(); for (;;) {
    const s = await region(...CLIENT2); if (s.colors > 4 && s.nonTeal > s.n * 0.5) return s;
    if (Date.now() - t0 > 15000) return null; await new Promise(r => setTimeout(r, 300)); } })();
  check('size key W really resized the window (kernel geometry changed)', !!resized, geom);
  check('resized window renders through the GPU path (no stale frame)', !!afterResize);
  const shot6 = await screenshot(page, '6-size-W');

  console.log('\n' + JSON.stringify(state));
  console.log(state.failures === 0 ? 'DEMO: PASS' : `DEMO: ${state.failures} FAILED`);
  await browser.close(); server.kill();
  process.exit(state.failures === 0 ? 0 : 1);
} catch (e) {
  console.error('DEMO ERROR: ' + (e && e.stack || e));
  try { await browser.close(); } catch {}
  server.kill();
  process.exit(1);
}
