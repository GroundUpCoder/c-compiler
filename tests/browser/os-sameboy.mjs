// SameBoy browser acceptance — the LIVE-RENDER half of the M3 menu gate
// (menu arch §4.b, todos/0260): /bin/sameboy is a win32 app whose GB client
// presents through the normal GDI bitmap transport (SetDIBits/StretchBlt ->
// shm), with its menu on the SAME menucore path gpubox (GPU transport, M2)
// exercises. The headless kernel e2e (test_sameboy_e2e.js) proves the menu
// machinery and exact palette bytes; this leg proves the composition story
// in the real compositor:
//   - the checkerboard test ROM composites and ANIMATES (SCX scroll) through
//     the shm transport, in the exact GB_PALETTE_GREY shades;
//   - the "menubar" strip child composites COLOR_MENU ABOVE the live client,
//     a bar click drops a "#32768" popup child over it, ESC dismisses;
//   - menu actions really act: Emulation>Pause freezes the animation
//     (time-separated probes go equal), and the NESTED submenu action
//     Options>Palette>DMG Green visibly re-colors the client to the DMG
//     green shades on the next frames;
//   - File>Quit (via wmctl click) exits cleanly, desktop restored.
//
// Usage: node os-sameboy.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3244;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 12));

  const TEAL = [0, 128, 128];
  const MENUFACE = [192, 192, 192];           // COLOR_MENU, gdi32 SYSCOLORS
  const GREYS = [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]];
  const DMGPAL = [[0x08, 0x18, 0x10], [0x39, 0x61, 0x39],
                  [0x84, 0xA5, 0x63], [0xC6, 0xDE, 0x8C]];
  const inSet = (got, set) => got && set.some(w => near(got, w, 8));

  // VTs (todos/0022): shell typing on VT1, canvas pixels on VT2.
  const { setVt } = osHelpers(page);

  // Launch from the real shell; the WM places the first window at (12,36).
  await setVt(1);   // 0070: ready lands on VT2; launch from the tty
  await page.keyboard.type('sameboy &\r');
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 200 });

  // Window geometry: surface at (12,36), 480x452 — the top 20px are the
  // anchored "menubar" strip child, the GB client (160x144 tripled) below.
  const BAR = 20;
  const WX = 12, WY = 36;
  const CX = WX + 240, CY = WY + BAR + 216;   // client center

  // Wait for the emulator to composite: the client center must show a
  // GB_PALETTE_GREY shade that is NOT the desktop teal (dmg_boot then the
  // checkerboard render both qualify; boot can take a while on first frame).
  const t0 = Date.now();
  for (;;) {
    const got = await sample(CX, CY);
    if (inSet(got, GREYS) && !near(got, TEAL)) break;
    if (Date.now() - t0 > 90000) throw new Error(`GB client never composited; last ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('GB client composited in exact GB_PALETTE_GREY shades (shm transport)', true);

  // M3 gate: the menu bar strip child composites ABOVE the live CPU client —
  // COLOR_MENU at the strip's right end (past the File/Emulation/Options
  // titles), exactly the probe the gpubox leg runs over a GPU client.
  check('menu bar strip composites over the live emulator (COLOR_MENU)',
    near(await sample(WX + 476, WY + 10), MENUFACE), await sample(WX + 476, WY + 10));

  // Animation: the checkerboard scrolls (SCX increments per GB frame), so a
  // probe row crosses tile boundaries — time-separated samples must differ.
  const probe = async () => [
    ...(await sample(CX + 45, CY)), ...(await sample(CX - 45, CY - 45)), ...(await sample(CX, CY + 45)),
  ];
  const a = await probe();
  let animated = false;
  for (let i = 0; i < 40 && !animated; i++) {
    await new Promise(r => setTimeout(r, 300));
    const b = await probe();
    animated = b.some((v, j) => Math.abs(v - a[j]) > 12);
  }
  check('checkerboard animates (GDI present loop is live)', animated);

  // A bar click drops a real "#32768" popup child over the animating client:
  // the probe just under the bar flips to COLOR_MENU, ESC restores it.
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "SameBoy$" | sed "s/[^0-9].*//"); wmctl click $SID 12 10\r');
  await setVt(2);
  const tP = Date.now();
  for (;;) {
    const got = await sample(WX + 2 + 8, WY + BAR + 9);   // popup-rel (8,9): row-0 gutter
    if (near(got, MENUFACE)) break;
    if (Date.now() - tP > 30000) throw new Error(`popup never composited over the client; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('bar click opened a popup child over the live GB client', true);
  await setVt(1);
  await page.keyboard.type('wmctl key $SID 41 27\r');   // ESC closes the popup
  await setVt(2);
  const tE = Date.now();
  for (;;) {
    const got = await sample(WX + 2 + 8, WY + BAR + 9);
    if (!near(got, MENUFACE)) break;
    if (Date.now() - tE > 30000) throw new Error(`popup never dismissed; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('ESC dismissed the popup; client pixels back', true);

  // Emulation > Pause via the agent path (label click, menu closed — A12):
  // the frame loop freezes, so probes that just proved animation go equal.
  // sameboy's marker on the tty is the sync point (posted WM_COMMAND lands
  // on the next pump tick — never race it).
  await setVt(1);
  await page.keyboard.type('wmctl click Pause\r');
  await page.waitForFunction(() => window.__osOut.includes('sameboy: pause on'), { timeout: 20000, polling: 200 });
  await setVt(2);
  const s0 = await probe();
  let frozen = true;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 400));
    const s1 = await probe();
    if (s1.some((v, j) => Math.abs(v - s0[j]) > 4)) { frozen = false; break; }
  }
  check('Emulation>Pause froze the client (time-separated probes equal)', frozen);
  await setVt(1);
  await page.keyboard.type('wmctl click Pause\r');
  await page.waitForFunction(() => window.__osOut.includes('sameboy: pause off'), { timeout: 20000, polling: 200 });
  await setVt(2);

  // Nested submenu action over the live client: Options>Palette>DMG Green
  // re-colors the next presented frames to the DMG green shades.
  await setVt(1);
  await page.keyboard.type('wmctl click "DMG Green"\r');
  await page.waitForFunction(() => window.__osOut.includes('sameboy: palette 1'), { timeout: 20000, polling: 200 });
  await setVt(2);
  const tG = Date.now();
  for (;;) {
    const got = await sample(CX, CY);
    if (inSet(got, DMGPAL)) break;
    if (Date.now() - tG > 30000) throw new Error(`client never went DMG-green; probe ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('Palette>DMG Green visibly re-colored the live client (nested submenu action)', true);

  // Quit through the menu; desktop restored.
  await setVt(1);
  await page.keyboard.type('wmctl click Quit\r');
  await setVt(2);
  const t1 = Date.now();
  for (;;) {
    const got = await sample(CX, CY);
    if (near(got, TEAL)) break;
    if (Date.now() - t1 > 30000) throw new Error(`window never closed; center ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('File>Quit closed sameboy; desktop restored', true);

  await setVt(1);
  await page.keyboard.type('echo SB-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('SB-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after the emulator exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos sameboy (browser): PASS' : `\nos sameboy (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
