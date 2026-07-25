// Mobile OSK browser acceptance — the on-screen keyboard (os/osk.js).
//
// The OSK is a synthetic-key soft keyboard: ONE component, TWO first-class
// backends. On VT2 every tap ships the same plain {kind:'key'} record a
// physical keyboard produces (bit-identical at the routeInput seam — the
// kernel/wm never learn the OSK exists); on VT1 it ships tty bytes through
// the vt1Input funnel. Sticky modifiers send REAL modifier keydown/keyup
// (arm/disarm), merge into every event, and one-shots disarm at the next
// key's KEYUP (the kernel swallows a chord's keyup only while the mod bits
// are held — disarming at keydown would leak half a chord). The #osk pane
// is a flex SIBLING of the VT panes, so opening it shrinks the desktop ->
// screen-resize -> the wm re-lays + re-clamps (occlusion by layout, zero
// kernel change; composes with the VT2 zoom's floor(pane/Z)).
//
// This file proves the acceptance set end-to-end in the booted OS:
//   (a) OSK-typed text lands in a running app (term -> file -> cat)
//   (b) named keys (Esc/Tab/arrows/Fn) via both backends
//   (c) sticky-mod chords: Ctrl+Esc Start menu, Ctrl+Alt+Tab cycle,
//       term ^C, Ctrl+Shift+C copy (multi-arm)
//   (d) the focused window is never hidden (pane shrink re-clamps it)
//   (e) OSK x zoom product (Z=2 geometry + the /Z pointer seam)
//   (f) VT1 still types through the tty-byte backend
//   plus key repeat (never for mods), tap-lock visuals, persistence.
//
// Usage: node os-osk.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3265;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  // serve.js may re-bake a stale image before listening — allow for it.
  await waitForServer(URL, { tries: 240, interval: 500 });
  // A phone-shaped viewport (min dimension <= 700): the OSK and the 2x zoom
  // both auto-default ON (the #69 D6 saved-else-viewport-default shape).
  const context = await browser.newContext({
    viewport: { width: 640, height: 1000 }, hasTouch: true });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut } = osHelpers(page);
  const FACE = [192, 192, 192];
  const pause = (ms) => page.waitForTimeout(ms);
  const osk = (sel) => `#osk [data-k="${sel}"]`;
  const tap = (k) => page.evaluate((kk) => window.__osOskTap(kk), k);
  const oskState = () => page.evaluate(() => window.__osOsk);
  const ttyType = (s) => page.keyboard.type(s, { delay: 40 });
  // The screen is settled at zoom Z when the last-sent LOGICAL size equals
  // floor(pane/Z) and the taskbar has re-laid at the new bottom edge
  // (sample()/waitPixel address LOGICAL/backing pixels — drawImage copies
  // the backing store unscaled).
  const settleZoom = async (Z) => {
    await page.waitForFunction((z) => {
      const p = document.getElementById('desktop');
      const s = window.__osScreen;
      return s && s.w === Math.floor(p.clientWidth / z) && s.h === Math.floor(p.clientHeight / z);
    }, Z, { timeout: 30000, polling: 150 });
    const s = await page.evaluate(() => window.__osScreen);
    await waitPixel(s.w - 9, s.h - 18, FACE, 60000, 'taskbar re-laid');   // Show Desktop sliver face (right edge)
    return s;
  };
  // wmctl list geometry for an exact title. The line is TAB-separated:
  // SID PID WxH+X+Y DST Z FLAGS TITLE (rec_flags: 'f' first = focused).
  // Lines from earlier list calls also match, so take the LAST one — the
  // marker wait guarantees this call's output has landed.
  const winGeom = async (title, marker) => {
    await setVt(1);
    await ttyType(`wmctl list | grep '${title}$'; echo G-${marker}""END\r`);
    await waitOut(`G-${marker}END`);
    return page.evaluate((t) => {
      const l = window.__osOut.split('\n').filter(x => new RegExp('\\t' + t + '\\s*$').test(x));
      const p = (l[l.length - 1] || '').split('\t');
      if (p.length < 7) return null;
      const m = p[2].match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
      return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4], flags: p[5], focused: p[5][0] === 'f' } : null;
    }, title);
  };

  // ---- defaults: phone viewport auto-opens the OSK; toggle lit; probes ----
  const d = await page.evaluate(() => ({
    osk: window.__osOsk,
    dataOsk: document.body.hasAttribute('data-osk'),
    btnOn: document.getElementById('oskbtn').classList.contains('on'),
    visible: document.getElementById('osk').offsetParent !== null,
    zoom: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.osk.open'),
  }));
  check('phone viewport auto-opens the OSK (probe + data-osk + lit toggle, nothing persisted)',
    d.osk && d.osk.open && d.dataOsk && d.btnOn && d.visible && d.stored === null, d);
  check('boots on layer abc with all mods off',
    d.osk.layer === 'abc' &&
    ['Control', 'Alt', 'Shift', 'Meta'].every(m => d.osk.mods[m] === 'off'), d.osk);
  check('phone viewport boots at the 1x zoom default beside the OSK (v163 contract)', d.zoom === 1, d.zoom);

  // ==== VT1: the tty-byte backend =========================================
  await setVt(1);
  check('keystrip hidden while the OSK is open (the OSK supersedes it)',
    await page.evaluate(() => document.getElementById('keystrip').offsetParent === null), true);

  // (f) full pointer path: REAL clicks spell a command across layer
  // switches; quote-split output so the typed echo can't satisfy the wait.
  for (const k of ['e', 'c', 'h', 'o', 'Space', 'v', 't']) await page.click(osk(k));
  await page.click(osk('?123'));
  check('?123 switches to the sym layer', (await oskState()).layer === 'sym', await oskState());
  for (const k of ['1', '-']) await page.click(osk(k));
  await page.click(osk('abc'));
  await page.click(osk('o'));
  await page.click(osk('?123'));
  for (const k of ["'", "'"]) await page.click(osk(k));
  await page.click(osk('abc'));
  await page.click(osk('k'));
  await page.click(osk('Enter'));
  await waitOut('vt1-ok');
  check('OSK-clicked command ran on VT1 (echo vt1-o\'\'k -> vt1-ok)', true);

  // Sticky Ctrl: arm (probe + armed style), one-shot ^U kills a dirty line.
  await tap('x');                                  // dirty the line
  await page.click(osk('Ctrl'));
  const armed = await page.evaluate(() => ({
    st: window.__osOsk.mods.Control,
    cls: document.querySelector('#osk .oskkey.armed') !== null,
  }));
  check('Ctrl arms one-shot (probe + armed style)', armed.st === 'armed' && armed.cls, armed);
  await tap('u');                                  // ^U = kill line
  check('one-shot Ctrl consumed after the key', (await oskState()).mods.Control === 'off', true);
  await ttyType('echo cl""ean\r');
  await waitOut('clean');
  check('sticky Ctrl+u killed the dirty line (command ran clean)', true);

  // Tap-lock: Ctrl Ctrl -> locked (style), survives a key, third tap off.
  await page.click(osk('Ctrl'));
  await page.click(osk('Ctrl'));
  const locked = await page.evaluate(() => ({
    st: window.__osOsk.mods.Control,
    cls: document.querySelector('#osk .oskkey.locked') !== null,
  }));
  check('double-tap locks Ctrl (probe + locked style)', locked.st === 'locked' && locked.cls, locked);
  await tap('a');                                  // ^A: harmless line-home
  check('locked Ctrl survives a key', (await oskState()).mods.Control === 'locked', true);
  await page.click(osk('Ctrl'));
  check('third tap disarms the lock', (await oskState()).mods.Control === 'off', true);

  // Shift one-shot at the byte seam: 'a' folds to 'A', then auto-disarms.
  await tap('Shift');
  await tap('a');
  const shiftSent = await page.evaluate(() => window.__osOskSent().slice(-1)[0]);
  check('armed Shift folds a -> A at the tty seam and one-shots off',
    shiftSent.be === 'tty' && shiftSent.ev === 'A' &&
    (await oskState()).mods.Shift === 'off', shiftSent);
  await tap('Ctrl'); await tap('u');               // clean the 'A'

  // (b) arrows on VT1: Up recalls history (side effect counted in a file).
  await ttyType('echo y >> /root/r\r');
  await waitOut('/root/r');
  await tap('Up');
  await pause(200);            // VT1 input pacing (recall repaints the line)
  await page.click(osk('Enter'));
  await ttyType('echo N=$(wc -l < /root/r)=M\r');
  await waitOut('N=2=M');
  check('OSK Up recalled history on VT1 (file appended twice)', true);

  // (b) named keys at the byte seam: Fn layer F5 / PageUp escape sequences.
  await page.click(osk('Fn'));
  check('Fn switches to the num layer', (await oskState()).layer === 'num', true);
  await tap('F5');
  await tap('PageUp');
  const fnSent = await page.evaluate(() => window.__osOskSent().slice(-2));
  check('F5/PgUp emit their escape sequences on the tty backend',
    fnSent[0].ev === '\x1b[15~' && fnSent[1].ev === '\x1b[5~', fnSent);
  await page.click(osk('abc'));
  await tap('Ctrl'); await tap('u');               // clean any residue

  // Key repeat: hold x ~1s -> the delay+30Hz timer floods the line; a held
  // modifier must NOT repeat (asserted on VT2 below where arms emit events).
  await page.evaluate(() => window.__osOskDown('x'));
  await pause(1000);
  await page.evaluate(() => window.__osOskUp());
  await page.waitForFunction(() => /x{8,}/.test(window.__osOut), { timeout: 5000, polling: 100 });
  check('held key repeats on VT1 (>=8 x\'s echoed)', true);
  await tap('Ctrl'); await tap('u');

  // ==== VT2: the wm-key backend ===========================================
  await ttyType('winbox &\r');
  await pause(300);
  await setVt(2);
  await page.evaluate(() => window.__osVt2SetZoom(1));   // Z=1: CSS == logical
  const s1 = await settleZoom(1);
  check('VT2 settles at Z=1 with the OSK pane open', true);

  // (d) occlusion: closing the OSK (real toggle click) grows the logical
  // screen; a window parked at the deep bottom re-clamps INTO view when the
  // OSK re-opens.
  await page.click('#oskbtn');
  check('toggle click closes the OSK and unlights the button',
    await page.evaluate(() => !window.__osOsk.open &&
      !document.getElementById('oskbtn').classList.contains('on')), true);
  const sBig = await settleZoom(1);
  check('closing the OSK grows the desktop pane', sBig.h > s1.h + 60, { open: s1.h, closed: sBig.h });
  const gLow = { x: 20, y: sBig.h - 30 };
  await setVt(1);
  await ttyType(`WSID=$(wmctl list | grep 'winbox$' | sed 's/[^0-9].*//'); wmctl move $WSID ${gLow.x} ${gLow.y}; echo MO""VED\r`);
  await waitOut('MOVED');
  await setVt(2);
  await page.evaluate(() => window.__osOskToggle(true));
  await settleZoom(1);
  await pause(800);             // wm EV_SCREEN re-clamp settle (no marker)
  const gClamped = await winGeom('winbox', 'W1');
  check('re-opening the OSK re-clamps the bottom window into the shrunken screen',
    gClamped && gClamped.y < gLow.y && gClamped.y - 12 >= 0 && gClamped.y - 12 < s1.h,
    { before: gLow, after: gClamped, screenH: s1.h });

  // (a) type into a running app: term (a real pty + hush) via OSK taps.
  await setVt(1);
  await ttyType('term &\r');
  await ttyType('wmctl wait win term && echo T""WIN\r');
  await waitOut('TWIN');
  await setVt(2);
  await settleZoom(1);
  await pause(1600);            // EV_SCREEN quiesce (late resize would drop focus/popups)
  const gTerm = await winGeom('term', 'T1');
  check('term window is up', !!gTerm, gTerm);
  await setVt(2);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + gTerm.x + Math.floor(gTerm.w / 2),
                         rect.y + gTerm.y + Math.floor(gTerm.h / 2));
  await pause(300);             // focus settle (no page-observable marker)
  // echo t2ok > /root/t2  — layers: '2' on sym, '>' on num, '/' on abc.
  for (const k of ['e', 'c', 'h', 'o', 'Space', 't']) await tap(k);
  await tap('?123'); await tap('2'); await tap('abc');
  for (const k of ['o', 'k', 'Space']) await tap(k);
  await tap('Fn'); await tap('>'); await tap('abc');
  for (const k of ['Space', '/', 'r', 'o', 'o', 't', '/', 't']) await tap(k);
  await tap('?123'); await tap('2'); await tap('abc'); await tap('Enter');
  await setVt(1);
  await ttyType('cat /root/t2\r');
  await waitOut('t2ok');
  check('OSK-typed command ran inside term on VT2 (echo t2ok -> file -> cat)', true);

  // (c) term ^C: interrupt a sleep, then the follow-up runs immediately.
  await setVt(2);
  for (const k of ['s', 'l', 'e', 'e', 'p', 'Space']) await tap(k);
  await tap('?123'); await tap('3'); await tap('0'); await tap('abc'); await tap('Enter');
  await pause(400);             // let sleep take the tty (no marker)
  await tap('Ctrl'); await tap('c');               // ^C via the mod fold
  for (const k of ['e', 'c', 'h', 'o', 'Space', 'i', 'n', 't', 'o', 'k', 'Space']) await tap(k);
  await tap('Fn'); await tap('>'); await tap('abc');
  for (const k of ['Space', '/', 'r', 'o', 'o', 't', '/', 'i']) await tap(k);
  await tap('Enter');
  await setVt(1);
  await ttyType('cat /root/i\r');
  await waitOut('intok');
  check('sticky Ctrl+c delivered SIGINT inside term (sleep 30 interrupted)', true);

  // (c) Ctrl+Shift+C copy — MULTI-ARM: select text in term by mouse drag,
  // then chord through two armed mods; the kernel slot proves it via clip.
  await setVt(2);
  // Type via OSK taps (the wmSend path needs no DOM focus; a hidden xterm
  // textarea can steal it back after VT flips, silently eating page.keyboard).
  // NB no `clear` — it is not a seeded applet, so screen rows accumulate;
  // select the WHOLE visible client instead of guessing an output row.
  for (const k of ['e', 'c', 'h', 'o', 'Space', 'c', 'o', 'p', 'y', 'm', 'e']) await tap(k);
  await tap('Enter');
  await pause(400);             // output paint (no marker)
  // Drag corner-to-corner, clamped to the visible screen — motion routes to
  // term by hit test, so the pointer must stay on-canvas (the window's
  // right edge is clipped at the phone-width screen). Anchor BELOW the
  // 0273c menu-bar strip (the top MENU_BAR_H=30px are a child window that
  // swallows the down — a drag from y+4 opens the File menu, not a
  // selection) and left of the 0273b scrollbar band at the right edge.
  const GRID_Y = 30;   // term.c GRID_Y = MENU_BAR_H (menucore.h)
  const selX1 = Math.min(gTerm.x + gTerm.w - 12, s1.w - 4);
  await page.mouse.move(rect.x + gTerm.x + 4, rect.y + gTerm.y + GRID_Y + 4);
  await page.mouse.down();
  await page.mouse.move(rect.x + selX1, rect.y + gTerm.y + gTerm.h - 8, { steps: 8 });
  await page.mouse.up();
  // Selection renders INVERTED (a selected blank cell takes the fg color):
  // poll a bottom-region blank cell for brightness — proves the drag built
  // a live selection before the chord fires.
  {
    const px = gTerm.x + 200, py = gTerm.y + gTerm.h - 30;
    const t0 = Date.now();
    let sel = [0, 0, 0];
    while (Date.now() - t0 < 8000) {
      sel = await sample(px, py);
      if (sel[0] + sel[1] + sel[2] > 240) break;
      await pause(150);
    }
    check('drag built a rendered (inverted) term selection', sel[0] + sel[1] + sel[2] > 240, sel);
  }
  await tap('Ctrl'); await tap('Shift');
  const multi = await oskState();
  check('multi-arm: Ctrl AND Shift armed together',
    multi.mods.Control === 'armed' && multi.mods.Shift === 'armed', multi.mods);
  await tap('c');                                  // key 'C' + Ctrl+Shift mods
  const chordEv = await page.evaluate(() =>
    window.__osOskSent().filter(s => s.be === 'wm' && s.ev.down && s.ev.code === 'KeyC').slice(-1)[0]);
  check('chord event carries KeyC as \'C\' with Control+Shift merged',
    chordEv && chordEv.ev.key === 'C' && chordEv.ev.mods.Control && chordEv.ev.mods.Shift, chordEv);
  const after = await oskState();
  check('both one-shots consumed at the chord keyup',
    after.mods.Control === 'off' && after.mods.Shift === 'off', after.mods);
  await setVt(1);
  await ttyType('clip -o\r');
  await waitOut('copyme');
  check('Ctrl+Shift+C copied the term selection to the system clipboard', true);

  // (c) Ctrl+Esc: the kernel Start-menu chord (scancode 41 + CTRL mod). The
  // keyup is swallowed because Ctrl is STILL armed at Esc's release — the
  // disarm-on-keyup rule in action.
  await setVt(2);
  await pause(1600);            // EV_SCREEN quiesce before popup work
  const SM_Y = s1.h - 28 - 274;                    // menu panel top (192x274)
  const menuPx = 120, menuPy = SM_Y + 74;
  const before = await sample(menuPx, menuPy);
  check('menu spot is not menu-face before the chord', !near(before, FACE), before);
  await tap('Ctrl'); await tap('Escape');
  await waitPixel(menuPx, menuPy, FACE, 30000, 'Start menu opened by the OSK Ctrl+Esc chord');
  check('sticky Ctrl+Esc opened the Start menu', true);
  check('Ctrl one-shot consumed by the chord', (await oskState()).mods.Control === 'off', true);
  await tap('Escape');                             // menu root has focus: dismiss
  await pause(400);             // menu dismiss settle (no marker)

  // (c) Ctrl+Alt+Tab: the kernel cycle chord flips wm focus between the two
  // windows (list flag 'f' moves).
  const focusBefore = await winGeom('term', 'F1');
  const wbBefore = await winGeom('winbox', 'F2');
  check('exactly one of term/winbox is focused before the cycle',
    focusBefore.focused !== wbBefore.focused, { term: focusBefore, winbox: wbBefore });
  await setVt(2);
  await tap('Ctrl'); await tap('Alt');
  const dualArm = await oskState();
  check('Ctrl+Alt both armed for the cycle chord',
    dualArm.mods.Control === 'armed' && dualArm.mods.Alt === 'armed', dualArm.mods);
  await tap('Tab');
  const focusAfter = await winGeom('term', 'F3');
  const wbAfter = await winGeom('winbox', 'F4');
  check('Ctrl+Alt+Tab cycled wm focus (the f flag moved)',
    focusAfter.focused !== focusBefore.focused && wbAfter.focused !== wbBefore.focused,
    { before: { term: focusBefore.focused, wb: wbBefore.focused },
      after: { term: focusAfter.focused, wb: wbAfter.focused } });

  // (e) OSK x zoom: Z=2 with the OSK open — logical screen is floor(pane/2),
  // the taskbar re-lays, and a physical click still maps through /Z (the
  // Start button opens its menu at CSS = logical * 2).
  await setVt(2);
  await page.evaluate(() => window.__osVt2SetZoom(2));
  const s2 = await settleZoom(2);
  const pane2 = await page.evaluate(() => {
    const p = document.getElementById('desktop');
    return { w: p.clientWidth, h: p.clientHeight };
  });
  check('Z=2 x OSK: logical screen is floor(shrunken-pane/2)',
    s2.w === Math.floor(pane2.w / 2) && s2.h === Math.floor(pane2.h / 2), { s2, pane2 });
  await pause(1600);            // EV_SCREEN quiesce before popup work
  const rect2 = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const SM2_Y = s2.h - 28 - 274 + 74;
  await page.mouse.click(rect2.x + 25 * 2, rect2.y + (s2.h - 14) * 2);   // Start at CSS = logical*2
  await waitPixel(120, SM2_Y, FACE, 30000, 'Start menu at Z=2 with the OSK open');
  check('Start click maps through /Z with the OSK pane open', true);
  await tap('Escape');
  await pause(400);             // menu dismiss settle (no marker)
  await page.evaluate(() => window.__osVt2SetZoom(1));
  await settleZoom(1);

  // Modifiers NEVER repeat: hold Ctrl ~900ms on the wm backend — exactly one
  // ControlLeft keydown (the arm), zero repeats; unwind through lock -> off.
  const sentBase = await page.evaluate(() => {
    const log = window.__osOskSent();
    return log.length ? log[log.length - 1].seq : 0;   // capped log: use seq
  });
  await page.evaluate(() => window.__osOskDown('Ctrl'));
  await pause(900);
  await page.evaluate(() => window.__osOskUp());
  const modEvents = await page.evaluate((base) =>
    window.__osOskSent().filter(s => s.seq > base && s.be === 'wm' && s.ev.code === 'ControlLeft'), sentBase);
  check('held modifier sends ONE keydown and never repeats',
    modEvents.length === 1 && modEvents[0].ev.down && !modEvents[0].ev.repeat, modEvents);
  await tap('Ctrl');                               // armed -> locked
  await tap('Ctrl');                               // locked -> off (keyup)
  const unwound = await page.evaluate((base) =>
    window.__osOskSent().filter(s => s.seq > base && s.be === 'wm' && s.ev.code === 'ControlLeft'), sentBase);
  check('lock unwind sends exactly the disarm keyup',
    unwound.length === 2 && !unwound[1].ev.down &&
    (await oskState()).mods.Control === 'off', unwound);

  // Persistence: an explicit close persists and beats the phone auto-default
  // across a reload (the zoom-control precedent).
  await page.evaluate(() => window.__osOskToggle(false));
  check('explicit close persisted', await page.evaluate(() =>
    localStorage.getItem('gucos.osk.open')) === '0', true);
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  const re = await page.evaluate(() => ({
    open: window.__osOsk.open,
    dataOsk: document.body.hasAttribute('data-osk'),
  }));
  check('explicit choice overrides the phone auto-default after reload',
    !re.open && !re.dataOsk, re);
  await page.evaluate(() => window.__osOskToggle(true));
  check('reopen works post-reload and persists', await page.evaluate(() =>
    window.__osOsk.open && localStorage.getItem('gucos.osk.open') === '1'), true);
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
console.log(state.failures === 0 ? '\nos osk (browser): PASS' : `\nos osk (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
