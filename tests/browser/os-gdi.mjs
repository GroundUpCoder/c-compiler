// gdi32 browser acceptance (todos/0057, design todos/WIN32.md): boot the
// reference OS page in headless Chromium, launch the seeded /bin/gdidemo
// from the shell, and assert the Petzold-style GDI scene composits
// correctly on the desktop canvas — shapes, hatch, thick lines, text ink,
// blits — at the exact coordinates os/win32/gdidemo.c draws (the headless
// twin, tests/kernel/test_gdi32_e2e.js, probes the same geometry off
// `wmctl shot`; this leg proves the same pixels through the real
// compositor). Close box -> SDL_EVENT_QUIT -> app exits.
//
// Usage: node os-gdi.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3333;   // unique per member (#546)
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
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);

  const TEAL = [0, 128, 128], WHITE = [255, 255, 255], NAVY = [0, 0, 128];

  await setVt(2);
  await waitScreen();

  // Launch the seeded gdi32 demo from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('gdidemo &\r');
  await setVt(2);

  // The WM places the first window at (12,36); the scene is 480x360 and
  // every coordinate below mirrors os/win32/gdidemo.c draw_scene.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];

  await waitPixel(...at(80, 60), [220, 40, 40], 60000);
  check('Rectangle interior red composited', true);
  check('white scene background', near(await sample(...at(145, 60)), WHITE), await sample(...at(145, 60)));
  check('Rectangle border black (3px pen)', near(await sample(...at(20, 60)), [0, 0, 0]), await sample(...at(20, 60)));
  check('Ellipse interior blue', near(await sample(...at(220, 60)), [40, 80, 220]), await sample(...at(220, 60)));
  check('RoundRect interior green', near(await sample(...at(370, 60)), [40, 180, 90]), await sample(...at(370, 60)));
  check('RoundRect corner rounded off (white)', near(await sample(...at(302, 22)), WHITE), await sample(...at(302, 22)));
  check('Polygon interior yellow', near(await sample(...at(80, 197)), [250, 200, 40]), await sample(...at(80, 197)));
  check('thick-pen X crossing', near(await sample(...at(370, 180)), [180, 30, 30]), await sample(...at(370, 180)));
  check('BitBlt checker top-left blue', near(await sample(...at(30, 320)), [0, 120, 215]), await sample(...at(30, 320)));
  check('BitBlt checker top-right white', near(await sample(...at(50, 320)), WHITE), await sample(...at(50, 320)));
  check('StretchBlt 2x bottom-right blue', near(await sample(...at(130, 340)), [0, 120, 215]), await sample(...at(130, 340)));

  // Text: TextOut rows carry ink (scan a row band for any non-white pixel).
  let ink = null;
  for (let x = 20; x < 140 && !ink; x += 2) {
    const p = await sample(...at(x, 255));
    if (!near(p, WHITE, 12)) ink = p;
  }
  check('TextOut ink composited', ink !== null, ink);
  // OPAQUE background cell: an exact-yellow pixel exists on the row.
  let yellow = null;
  for (let x = 20; x < 90 && !yellow; x += 2) {
    const p = await sample(...at(x, 285));
    if (near(p, [255, 255, 0])) yellow = p;
  }
  check('OPAQUE TextOut yellow bk cell composited', yellow !== null, yellow);

  check('focused title bar navy', near(await sample(...at(150, -12)), NAVY), await sample(...at(150, -12)));

  // Close box -> SDL_EVENT_QUIT -> WM_DESTROY -> exit; desktop restored.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + WX + 480 - 12, rect.y + WY - 12);
  await waitPixel(...at(240, 180), TEAL);
  check('close box quit gdidemo; desktop restored', true);

  // The shell survives its windowed child.
  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // GDI-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo GDI-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('GDI-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after gdidemo exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos gdi (browser): PASS' : `\nos gdi (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
