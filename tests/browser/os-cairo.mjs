// cairo browser acceptance (todos/0061): boot the reference OS page in
// headless Chromium, launch the seeded /bin/cairodemo from the shell, and
// assert the vector scene (radial gradient disc, translucent star, bezier
// ribbon, cairo-ft label) composits correctly on the desktop canvas at the
// coordinates vendor/cairo/demo/main.c draws (the headless twin,
// tests/kernel/test_cairo_e2e.js, probes the same anchors off `wmctl shot`;
// this leg proves the same pixels through the real compositor). A keypress
// toggles the dark theme (an shm repaint); close box -> SDL_EVENT_QUIT.
//
// Usage: node os-cairo.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3219;
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);

  const TEAL = [0, 128, 128], NAVY = [0, 0, 128];

  await setVt(2);
  await waitScreen();

  // Launch the seeded cairo demo from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('cairodemo &\r');
  await setVt(2);

  // The WM places the first window at (12,36); the scene is 480x360 and
  // every coordinate below mirrors vendor/cairo/demo/main.c draw_scene.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];

  await waitPixel(...at(120, 120), [255, 220, 79], 60000);
  check('radial disc center composited', true);
  check('bg gradient top', near(await sample(...at(240, 2)), [239, 239, 244]), await sample(...at(240, 2)));
  check('bg gradient bottom', near(await sample(...at(240, 358)), [200, 200, 219]), await sample(...at(240, 358)));
  check('translucent star over gradient', near(await sample(...at(340, 120)), [68, 175, 93]), await sample(...at(340, 120)));
  check('bezier ribbon mid', near(await sample(...at(240, 295)), [38, 89, 229], 12), await sample(...at(240, 295)));

  // cairo-ft label: scan the label band for dark ink.
  let ink = null;
  for (let x = 210; x < 460 && !ink; x += 4) {
    const p = await sample(...at(x, 318));
    if (p[0] < 0x50) ink = p;
  }
  check('cairo-ft label ink composited', ink !== null, ink);

  check('focused title bar navy', near(await sample(...at(150, -12)), NAVY), await sample(...at(150, -12)));

  // KEYDOWN (focused window) toggles the dark theme — an shm repaint.
  await page.keyboard.press('d');
  await waitPixel(...at(240, 2), [33, 33, 41]);
  check('dark theme repaint composited', true);
  check('disc center unchanged in dark theme', near(await sample(...at(120, 120)), [255, 220, 79]), await sample(...at(120, 120)));
  await page.keyboard.press('d');
  await waitPixel(...at(240, 2), [239, 239, 244]);
  check('light theme restored', true);

  // Close box -> SDL_EVENT_QUIT -> exit; desktop restored.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + WX + 480 - 12, rect.y + WY - 12);
  await waitPixel(...at(240, 180), TEAL);
  check('close box quit cairodemo; desktop restored', true);

  // The shell survives its windowed child.
  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // CAIRO-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo CAIRO-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('CAIRO-SHELL-OK'), { timeout: 20000, polling: 'raf' });
  check('shell alive after cairodemo exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos cairo (browser): PASS' : `\nos cairo (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
