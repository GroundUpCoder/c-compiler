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
import { createHash } from 'node:crypto';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, deskEntries, deskCell } from './lib/os-harness.mjs';
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

  const { setVt, waitOut, waitPixel, waitScreen } = osHelpers(page);
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

  // ---- touch-action contract (mobile-doubletap): every tappable chrome
  // control must compute `manipulation` so iOS drops its native
  // double-tap-to-zoom, while the two surfaces that own their touches keep
  // `none`. This is a PROPERTY check, not a gesture check — headless
  // Chromium cannot reproduce the iOS gesture, so what it guards is the CSS
  // contract the gesture depends on. It exists because the tab-bar cluster
  // shipped without the guard while the keys next to it had it: the
  // per-button shape kept getting forgotten, so the rule went
  // container-scoped (#vtbar/#keystrip subtrees) and this table asserts the
  // whole cluster, not one sample. Add a control to the bar -> add it here.
  const TOUCH_MANIP = ['.stripkey', '#vt1tab', '#vt2tab', '#oskbtn',
    '#fontminus', '#fontplus', '#zoomminus', '#zoomplus', '#desksite',
    '#uploadbtn', '#vtbar'];
  const touchActions = await page.evaluate((sels) => {
    const out = {};
    for (const s of sels.concat(['#screen', '#osk'])) {
      const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).touchAction : 'MISSING';
    }
    return out;
  }, TOUCH_MANIP);
  for (const sel of TOUCH_MANIP) {
    check(`${sel} computes touch-action manipulation (iOS double-tap-zoom kill)`,
      touchActions[sel] === 'manipulation', touchActions[sel]);
  }
  // The deliberate exceptions — these own every touch and must NOT be folded
  // into the blanket rule (todos/0212; the OSK/desktop gesture layers).
  check('#screen keeps touch-action none (owns its touches)',
    touchActions['#screen'] === 'none', touchActions['#screen']);
  check('#osk keeps touch-action none (owns its touches)',
    touchActions['#osk'] === 'none', touchActions['#osk']);

  // ---- Copy/Paste strip keys (mobile-ux): the tap-gesture clipboard path.
  // Headless grantPermissions stands in for the browser's clipboard gates
  // (same honest limit as os-clipboard.mjs): the iOS paste callout and the
  // gesture-dependent grant need the on-device check — the plumbing on both
  // sides of that gate is what these legs prove, with REAL key clicks.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Copy of a live xterm selection: host clipboard AND kernel slot get it.
  await page.keyboard.type('echo SEL-C""OPY-79\r', { delay: 60 });
  await waitOut('SEL-COPY-79');
  await page.evaluate(() => window.term.selectAll());
  await page.click('[data-key="Copy"]');
  await page.waitForFunction(() => (window.__osStripCopy || 0) >= 1,
    { timeout: 5000, polling: 100 });
  check('strip Copy fired (probe)', true);
  await page.waitForFunction(
    () => navigator.clipboard.readText().then((t) => t.includes('SEL-COPY-79')),
    { timeout: 10000, polling: 200 });
  check('strip Copy exported the xterm selection to the host clipboard', true);
  await page.evaluate(() => window.term.clearSelection());
  await page.keyboard.type('clip -o | grep "SEL-C""OPY-79" && echo CB-""HIT\r', { delay: 60 });
  await waitOut('CB-HIT');
  check('strip Copy committed the selection to the kernel slot (clip -o)', true);

  // Selection-less Copy re-exports the last agreed text — the iOS retry
  // path, where the automatic CLIP_SET writeText mirror was rejected for
  // want of a gesture. The dedupe bypass is the point: the text ALREADY
  // equals clipSynced, and the tap must still write it out.
  await page.keyboard.type("printf 'GUC-RETRY-79' | clip\r", { delay: 60 });
  await page.waitForFunction(() => window.__osClipLast === 'GUC-RETRY-79',
    { timeout: 15000, polling: 100 });
  await page.evaluate(() => navigator.clipboard.writeText('HOST-STOMP'));   // host moved on
  await page.click('[data-key="Copy"]');
  await page.waitForFunction(
    () => navigator.clipboard.readText().then((t) => t === 'GUC-RETRY-79'),
    { timeout: 10000, polling: 200 });
  check('selection-less strip Copy re-exports the last gucOS copy (dedupe-bypass retry)', true);

  // Paste: host clipboard -> tty bytes through xterm's paste path, plus the
  // kernel-slot import. The seeded text is a runnable split-needle command,
  // so the wait is only satisfied by hush EXECUTING the pasted line.
  await page.evaluate(() => navigator.clipboard.writeText('echo PASTE-""RT-79\n'));
  await page.click('[data-key="Paste"]');
  await page.waitForFunction(() => (window.__osStripPaste || 0) >= 1,
    { timeout: 10000, polling: 100 });
  await waitOut('PASTE-RT-79');
  check('strip Paste fed the host clipboard into the tty (pasted command ran)', true);
  await page.keyboard.type('clip -o | grep "RT-79" && echo SL""OT-OK\r', { delay: 60 });
  await waitOut('SLOT-OK');
  check('strip Paste imported the host text into the kernel slot', true);

  // ---- OSK tty clipboard (the clipboard seam, landing 2): the OSK is now
  // a REAL superset of the keystrip it hides — Ctrl+Shift+C/V run the same
  // gesture-scoped handlers (the chords every real terminal pastes on;
  // plain Ctrl+V stays the ^V literal-next fold), and the Fn layer carries
  // Copy/Paste legends for anyone who'd never guess the chord on a soft
  // keyboard. Synthetic __osOskTap probes are fine HERE: the VT1 handlers
  // are page-side readText/writeText with granted permissions (the
  // activation gate belongs to the VT2 seam, not this path).
  await page.evaluate(() => window.__osOskToggle(true));
  check('OSK open supersedes the keystrip (a true superset since the seam)',
    await page.evaluate(() =>
      document.getElementById('keystrip').offsetParent === null &&
      document.getElementById('osk').offsetParent !== null), true);
  // Ctrl+Shift+V pastes — a runnable split-needle command, so the wait is
  // satisfied only by hush EXECUTING the pasted line, never the echo.
  await page.evaluate(() => navigator.clipboard.writeText('echo OSK-PAS""TE-SEAM\n'));
  const oskPaste0 = await page.evaluate(() => window.__osStripPaste || 0);
  await page.evaluate(() => {
    window.__osOskTap('Ctrl'); window.__osOskTap('Shift'); window.__osOskTap('v');
  });
  await waitOut('OSK-PASTE-SEAM');
  check('OSK Ctrl+Shift+V pasted via the shared VT1 handler (command ran)', true);
  check('shared paste probe bumped',
    await page.evaluate((n) => (window.__osStripPaste || 0) > n, oskPaste0), true);
  const oskSent = await page.evaluate(() =>
    window.__osOskSent().filter(e => e.be === 'tty').map(e => e.ev));
  check('the chord logged <paste>, never a ^V fold (terminal fidelity)',
    oskSent.includes('<paste>') && !oskSent.includes('\x16'), oskSent);
  check('one-shot mods consumed by the chord',
    await page.evaluate(() =>
      window.__osOsk.mods.Control === 'off' && window.__osOsk.mods.Shift === 'off'),
    await page.evaluate(() => window.__osOsk.mods));
  // Ctrl+Shift+C exports the live xterm selection (the strip Copy contract).
  await page.keyboard.type('echo OSK-CO""PY-SEAM\r', { delay: 60 });
  await waitOut('OSK-COPY-SEAM');
  await page.evaluate(() => window.term.selectAll());
  await page.evaluate(() => {
    window.__osOskTap('Ctrl'); window.__osOskTap('Shift'); window.__osOskTap('c');
  });
  await page.waitForFunction(
    () => navigator.clipboard.readText().then((t) => t.includes('OSK-COPY-SEAM')),
    { timeout: 10000, polling: 200 });
  check('OSK Ctrl+Shift+C exported the xterm selection to the host', true);
  await page.evaluate(() => window.term.clearSelection());
  // The Fn-layer legends: live (undimmed) on the tty backend, dimmed +
  // inert on the wm backend (no app-agnostic copy/paste chord exists on
  // VT2 — the focused app's own contract governs there).
  await page.evaluate(() => window.__osOskTap('Fn'));
  check('Fn layer carries live Copy/Paste legends on the tty backend',
    await page.evaluate(() => {
      const c = document.querySelector('#osk [data-k="Copy"]');
      const p = document.querySelector('#osk [data-k="Paste"]');
      return !!c && !!p && !c.classList.contains('dim') && !p.classList.contains('dim');
    }), true);
  await page.evaluate(() => navigator.clipboard.writeText('echo LEGEND-PAS""TE-SEAM\n'));
  await page.evaluate(() => window.__osOskTap('Paste'));
  await waitOut('LEGEND-PASTE-SEAM');
  check('Fn-layer Paste legend runs the gesture-scoped paste', true);
  await setVt(2);
  check('legends dim on the wm backend (VT switch re-renders)',
    await page.evaluate(() =>
      document.querySelector('#osk [data-k="Paste"]').classList.contains('dim')), true);
  await setVt(1);
  await page.evaluate(() => window.__osOskTap('abc'));
  await page.evaluate(() => window.__osOskToggle(false));
  check('closing the OSK restores the keystrip (mid-file)',
    await page.evaluate(() =>
      document.getElementById('keystrip').offsetParent !== null), true);

  // ---- Upload button (mobile file ingest): visible on the touch UI; the
  // picker's change handler feeds the SAME {type:'drop-file'} path as
  // desktop drag-drop (os-drop.mjs owns that flavor + the hidden-on-desktop
  // gate). The picker DIALOG itself is un-drivable headless (a real iOS
  // Safari chooser) — synthesizing files onto the input and firing change
  // exercises everything from the handler down. ----
  check('Upload button visible on the touch UI',
    await page.evaluate(() =>
      document.getElementById('uploadbtn').offsetParent !== null), true);
  // Every byte value once: any transport mangling breaks the md5.
  const UP = Uint8Array.from({ length: 256 }, (_, i) => i);
  const UP_MD5 = createHash('md5').update(UP).digest('hex');
  await page.evaluate((arr) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(arr)], 'upload.bin'));
    const input = document.getElementById('uploadinput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, Array.from(UP));
  await page.waitForFunction(() => window.__osLogs.some(l =>
    l.startsWith('[drop]') && l.includes('upload.bin -> /root/Desktop/upload.bin (256 bytes)')),
    { timeout: 20000, polling: 200 });
  check('picker change posted drop-file (kernel logged the write)', true);
  check('input cleared after posting (same file re-pickable)',
    await page.evaluate(() =>
      document.getElementById('uploadinput').value === ''), true);
  // The icon appears on the desktop without a reboot (the wm ~1s re-read).
  await setVt(2);
  await waitScreen();
  const { h: UPSH } = await page.evaluate(() => window.__osScreen);
  const UPGRID = deskEntries(['upload.bin']);
  const UPBIN = deskCell(UPGRID, 'Recycle Bin', UPSH);
  await waitPixel(UPBIN.x + 44, UPBIN.y + 6 + 2, [255, 255, 255], 15000);
  check(`uploaded file's icon appeared (${UPGRID.length}-cell grid)`, true);
  // Byte identity through the shell (md5 over the brokered fs).
  await setVt(1);
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('md5sum /root/Desktop/upload.bin\r', { delay: 60 });
  await page.waitForFunction(() => /[0-9a-f]{32}/.test(window.__osOut),
    { timeout: 20000, polling: 200 });
  check('uploaded bytes byte-identical (md5)',
    (await page.evaluate(() => window.__osOut)).includes(UP_MD5), true);
  // While the bar FITS, #oskbtn's auto margin still right-aligns the
  // control cluster (the overflow flavor is the ctx3 legs below).
  check('right cluster right-aligned while the bar fits (oskbtn auto margin)',
    await page.evaluate(() => {
      const b = document.getElementById('vtbar');
      const osk = document.getElementById('oskbtn').getBoundingClientRect();
      const vt2 = document.getElementById('vt2tab').getBoundingClientRect();
      return b.scrollWidth <= b.clientWidth && (osk.left - vt2.right) > 100;
    }), true);

  // ---- the 18px choice survives a reload ----
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  const reFont = await page.evaluate(() => ({
    font: window.__osVt1Font, termFont: window.term.options.fontSize }));
  check('font choice persists across a reload',
    reFont.font === 18 && reFont.termFont === 18, reFont);
  await context.close();       // release the boot lock for the next context

  // ---- a fresh NARROW context (no touch, no storage): 26px default (the
  // ~3-steps-up phone default over the desktop 14: 14->18->22->26) and the
  // strip shows via the narrow half of the predicate ----
  const ctx2 = await browser.newContext({ viewport: { width: 500, height: 800 } });
  const page2 = await ctx2.newPage();
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page2.evaluate(() => window.__osVtSwitch(1));
  const narrow = await page2.evaluate(() => ({
    font: window.__osVt1Font,
    stored: localStorage.getItem('gucos.vt1.fontSize'),
    strip: document.getElementById('keystrip').offsetParent !== null,
    osk: window.__osOsk && window.__osOsk.open,
  }));
  // Since the mobile OSK: a phone-shaped viewport auto-OPENS the on-screen
  // keyboard, which supersedes the keystrip (a strict superset of its keys)
  // — so the strip is hidden here BY DESIGN. Closing the OSK brings it back.
  check('narrow viewport defaults larger (26px, unpersisted); OSK open supersedes the strip',
    narrow.font === 26 && narrow.stored === null && !narrow.strip && narrow.osk, narrow);
  await page2.evaluate(() => window.__osOskToggle(false));
  check('closing the OSK restores the keystrip',
    await page2.evaluate(() =>
      document.getElementById('keystrip').offsetParent !== null), true);
  await ctx2.close();

  // ---- a REAL phone width (360px): the VT2 bar (tabs + osk + zoom +
  // Desktop site + Upload) genuinely overflows — it must pan sideways on
  // ONE row, with the tail controls reachable and the tabs' 1px active-seam
  // descent NOT clipped by the scroll container (scrollHeight == clientHeight
  // is exactly that assertion). ----
  const ctx3 = await browser.newContext({
    viewport: { width: 360, height: 780 }, hasTouch: true });
  const page3 = await ctx3.newPage();
  await page3.goto(URL);
  await page3.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page3.evaluate(() => window.__osVtSwitch(2));   // zoomctl/desksite/upload visible
  const bar = await page3.evaluate(() => {
    const b = document.getElementById('vtbar');
    const s = getComputedStyle(b);
    return { overflowX: s.overflowX, wrap: s.flexWrap, shrink: getComputedStyle(document.getElementById('vt1tab')).flexShrink,
             scrollW: b.scrollWidth, clientW: b.clientWidth, atStart: b.scrollLeft === 0,
             oneRow: b.scrollHeight <= b.clientHeight,
             upVisible: document.getElementById('uploadbtn').offsetParent !== null };
  });
  check('phone VT2 bar overflows sideways (nowrap, unshrunk, scrollable, seam unclipped)',
    bar.overflowX === 'auto' && bar.wrap === 'nowrap' && bar.shrink === '0' &&
    bar.scrollW > bar.clientW && bar.atStart && bar.oneRow && bar.upVisible, bar);
  const tail = await page3.evaluate(() => {
    const b = document.getElementById('vtbar');
    b.scrollLeft = 100000;                    // clamp to max = scroll to end
    const br = b.getBoundingClientRect();
    const ur = document.getElementById('uploadbtn').getBoundingClientRect();
    return { moved: b.scrollLeft > 0, upRight: ur.right, barRight: br.right };
  });
  check('bar pans to the end; Upload (the tail control) reachable',
    tail.moved && tail.upRight <= tail.barRight + 1, tail);
  await ctx3.close();
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
