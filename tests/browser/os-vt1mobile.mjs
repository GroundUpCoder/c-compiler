// 0212 browser acceptance: VT1 mobile affordances — the tab bar's A−/A+
// font-size steps (live refit, localStorage persistence, larger default on
// a narrow viewport) and the #keystrip soft-keyboard helper row (Esc, Tab,
// sticky Ctrl, arrows, |~/-) feeding the ordinary tty input path. All
// page-side and VT1-only; the desktop path is untouched (the sweep's other
// files prove that side).
//
// Every strip key is verified by its EFFECT in the booted OS, not by a
// probe: Tab = hush completion, arrows = history recall (side-effect
// counted in a file), Esc = a real vi mode switch, sticky Ctrl composed
// with the keyboard = ^U line kill and ^D EOF.
//
// Usage: node os-vt1mobile.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
const PORT = 3251;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  // serve.js may re-bake a stale image before listening — allow for it.
  await waitForServer(URL, { tries: 240, interval: 500 });
  // hasTouch => navigator.maxTouchPoints > 0 => the strip shows even on a
  // wide viewport (the touch half of the touchUiSync predicate).
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, waitOut } = osHelpers(page);
  // timing subject: VT1 input pacing and the vi-mode settles (annotated at
  // each site; vi's mode switches paint no page-observable marker).
  const pause = (ms) => page.waitForTimeout(ms);
  await setVt(1);
  await pause(300);            // VT1 input pacing

  // ---- defaults on a wide viewport: 14px, strip visible (touch UI) ----
  const ui = await page.evaluate(() => ({
    font: window.__osVt1Font,
    termFont: window.term.options.fontSize,
    strip: document.getElementById('keystrip').offsetParent !== null,
    fontctl: document.getElementById('fontctl').offsetParent !== null,
    stored: localStorage.getItem('gucos.vt1.fontSize'),
  }));
  check('wide viewport defaults to 14px, nothing persisted yet',
    ui.font === 14 && ui.termFont === 14 && ui.stored === null, ui);
  check('key strip + font controls visible on VT1 touch UI',
    ui.strip && ui.fontctl, ui);

  // ---- A+ steps the font and refits; the choice persists ----
  const colsBefore = await page.evaluate(() => window.term.cols);
  await page.click('#fontplus');
  const after = await page.evaluate(() => ({
    font: window.__osVt1Font, termFont: window.term.options.fontSize,
    cols: window.term.cols, stored: localStorage.getItem('gucos.vt1.fontSize'),
  }));
  check('A+ steps 14 -> 18 and persists',
    after.font === 18 && after.termFont === 18 && after.stored === '18', after);
  check('refit shrank the column count', after.cols < colsBefore,
    { before: colsBefore, after: after.cols });
  await page.click('#fontminus');
  check('A- steps back to 14',
    await page.evaluate(() => window.__osVt1Font) === 14, true);
  await page.click('#fontplus');   // leave 18 for the reload-persist leg

  // ---- strip characters land in the tty (hush echoes them) ----
  await page.click('[data-key="~"]');
  await page.click('[data-key="/"]');
  await page.click('[data-key="-"]');
  await waitOut('~/-');
  check('strip |~/- keys reach the terminal', true);
  // sticky Ctrl composes with the soft keyboard: ^U kills the line, so the
  // next command actually runs (typed echo can't satisfy the split needle).
  await page.click('[data-key="Ctrl"]');
  check('Ctrl arms (probe + armed style)',
    await page.evaluate(() =>
      window.__osVt1Ctrl && document.querySelector('.stripkey.armed') !== null), true);
  await page.keyboard.type('u', { delay: 60 });
  check('Ctrl disarms after composing',
    await page.evaluate(() => !window.__osVt1Ctrl), true);
  await page.keyboard.type('echo CLE""AN\r', { delay: 60 });
  await waitOut('CLEAN');
  check('sticky Ctrl+u killed the dirty line (command ran clean)', true);

  // ---- Tab = hush completion: 'ec<Tab>' -> 'echo ' ----
  await page.keyboard.type('ec', { delay: 60 });
  await page.click('[data-key="Tab"]');
  await page.keyboard.type('TA""B-OK\r', { delay: 60 });
  await waitOut('TAB-OK');
  check('strip Tab completed "ec" to "echo "', true);

  // ---- arrows = history: recall doubles the side effect ----
  await page.keyboard.type('echo x >> /root/arr\r', { delay: 60 });
  await waitOut('/root/arr');
  await page.click('[data-key="↑"]');
  await pause(200);            // VT1 input pacing (recall repaints the line)
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo N=$(wc -l < /root/arr)=M\r', { delay: 60 });
  await waitOut('N=2=M');
  check('strip Up recalled the previous command (file appended twice)', true);

  // ---- Esc = a real vi mode switch ----
  await page.keyboard.type('vi /root/esc.txt\r', { delay: 60 });
  await waitOut('- /root/esc.txt');   // vi's status line ("- FILE 1/1 100%")
  await page.keyboard.type('i', { delay: 60 });
  await waitOut('I /root/esc.txt');   // insert-mode status ("I FILE 1/1 …")
  await page.keyboard.type('ESCVI', { delay: 60 });
  // In vi each echoed char rides its own cursor-move escape, so the literal
  // string never appears — wait for the caret to land past the 5th column.
  await waitOut('[1;6H');
  await page.click('[data-key="Esc"]');
  await pause(300);            // vi command-mode switch has no output marker
  await page.keyboard.type(':wq\r', { delay: 60 });
  await page.keyboard.type('echo E=$(cat /root/esc.txt)=Z\r', { delay: 60 });
  await waitOut('E=ESCVI=Z');
  check('strip Esc left vi insert mode (:wq wrote the file)', true);

  // ---- sticky Ctrl + d = EOF ends cat ----
  await page.keyboard.type('cat && echo CA""T-OK\r', { delay: 60 });
  await pause(300);            // VT1 input pacing (cat now owns stdin)
  await page.click('[data-key="Ctrl"]');
  await page.keyboard.type('d', { delay: 60 });
  await waitOut('CAT-OK');
  check('sticky Ctrl+d sent EOF (cat exited 0)', true);

  // ---- the 18px choice survives a reload ----
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  const reFont = await page.evaluate(() => ({
    font: window.__osVt1Font, termFont: window.term.options.fontSize }));
  check('font choice persists across a reload',
    reFont.font === 18 && reFont.termFont === 18, reFont);
  await context.close();       // release the boot lock for the next context

  // ---- a fresh NARROW context (no touch, no storage): 18px default and
  // the strip shows via the narrow half of the predicate ----
  const ctx2 = await browser.newContext({ viewport: { width: 500, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page2.evaluate(() => window.__osVtSwitch(1));
  const narrow = await page2.evaluate(() => ({
    font: window.__osVt1Font,
    stored: localStorage.getItem('gucos.vt1.fontSize'),
    strip: document.getElementById('keystrip').offsetParent !== null,
  }));
  check('narrow viewport defaults larger (18px, unpersisted) with the strip shown',
    narrow.font === 18 && narrow.stored === null && narrow.strip, narrow);
  await ctx2.close();
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {
    const pages = browser.contexts().flatMap(c => c.pages());
    if (pages.length) {
      const tail = await pages[0].evaluate(() => window.__osOut.slice(-600));
      console.error('tty tail: ' + JSON.stringify(tail));
    }
  } catch {}
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos vt1mobile (browser): PASS' : `\nos vt1mobile (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
