// 0094 browser acceptance: the event-sound scheme in the real OS page.
// Boot os.html in headless Chromium and assert, end to end:
//   - the wm startup chime reached the kernel mixer's OUTPUT ring before
//     any user gesture (autoplay policy holds playback, not mixing)
//   - after the resume gesture the chime plays out ONCE (the producer
//     cursor advances, then goes quiet)
//   - raising a MessageBox (ctldemo's About) beeps — user32 MessageBeep ->
//     winmm PlaySound -> the scheme's SystemDefault clip
//   - the Control Panel Sounds applet's "Enable event sounds" checkbox
//     mutes events (the ~/.config/sounds store) and re-enables them
// Audio observability is os.html's __osAudioSab probe: word 0 (AU_WPOS)
// is the pump's producer cursor — it moves iff the mixer wrote output.
// No speakers needed; headless-safe (the receiver drains after the
// gesture exactly like os-doom.mjs's music leg).
//
// Usage: node os-sounds.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3336;   // unique per member (#546)
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  // serve.js re-bakes a stale system image BEFORE listening (0082) — allow
  // it the full bake, not just a settle.
  await waitForServer(URL, { tries: 600, interval: 200 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, waitOut } = osHelpers(page);
  const audioCtl = () => page.evaluate(() =>
    Array.from(new Int32Array(window.__osAudioSab, 0, 4)));
  const wposAt = async () => (await audioCtl())[0];
  // Positive-leg condition (#97/0287, retires the blind sleeps): the pump's
  // producer cursor advanced past `from` — i.e. the mixer really wrote output.
  const waitWpos = async (from, ms) => {
    await page.waitForFunction((f) =>
      new Int32Array(window.__osAudioSab, 0, 4)[0] !== f, from,
      { timeout: ms || 15000, polling: 'raf' });
    return wposAt();
  };
  // Negative-leg baseline: the mixer is QUIET — two cursor samples 500ms
  // apart are equal (a still-draining clip can't alias as an event beep).
  // The 500ms is a genuine no-marker settle: quiescence IS two equal samples.
  const waitQuiet = async (ms) => {
    const t0 = Date.now();
    for (;;) {
      const a = await wposAt();
      await sleep(500);
      const b = await wposAt();
      if (a === b) return b;
      if (Date.now() - t0 > (ms || 20000))
        throw new Error('mixer never went quiet: wpos ' + a + ' -> ' + b);
    }
  };

  // ---- the startup chime, pre-gesture: the wm service submits it at
  // desktop-ready (its worker boots ~1s AFTER the page's 'ready' — wait,
  // don't sample) and the pump mixes it into the output ring; nothing
  // drains until the gesture, so queuedBytes parks at the pump's target.
  // NB no typing/clicking before this — a gesture would start draining.
  await page.waitForFunction(() => window.__osAudioSab &&
    new Int32Array(window.__osAudioSab, 0, 4)[1] > 0, { timeout: 20000, polling: 'raf' });
  const ctl0 = await audioCtl();
  check('startup chime mixed into the output ring before any gesture',
    (await page.evaluate(() => window.__osAudio)) === 'ready' &&
    ctl0[0] > 0 && ctl0[1] > 0, ctl0);

  // ---- the resume gesture: chime plays out, then goes quiet (ONCE) ----
  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2;
  }, { timeout: 30000, polling: 'raf' });
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(rect.x + rect.w - 200, rect.y + 200);   // bare desktop
  await page.waitForFunction(() => window.__osAudio === 'playing', { timeout: 10000, polling: 'raf' });
  check('audio resumed on the gesture', true);
  const wEnd = await waitWpos(ctl0[0], 10000);   // the chime is draining out
  const wQuiet = await waitQuiet();              // ~2.2s clip ends, mixer parks
  check('chime played out once and the mixer went quiet',
    wQuiet !== ctl0[0], { wEnd, wQuiet });

  // ---- MessageBox raise beeps (MessageBeep -> PlaySound SystemDefault) ----
  // Every leg below gates on a REAL condition (#97/0287): dialog existence
  // via `wmctl wait win`, split-needle shell markers (the tty echo of the
  // typed line can't satisfy them), and cursor advance/quiescence polls —
  // the blind sleeps are gone. A timed-out in-OS wait is a hard failure
  // (the harness waitOut carries the drive.js-class guard).
  await setVt(1);
  await page.keyboard.type('echo VT""1-IN\r');   // tty accepts input post-switch
  await waitOut('VT1-IN');
  await page.keyboard.type('ctldemo &\r');
  await waitOut('ctldemo: ready', 120000);
  const w0 = await waitQuiet();                  // baseline: mixer parked
  await page.keyboard.type('wmctl click About && wmctl wait win "About ctldemo" 8000 && echo ABT""1-UP\r');
  await waitOut('ABT1-UP');
  const w1 = await waitWpos(w0, 10000);
  check('MessageBox raise beeps (producer cursor advanced)', w1 !== w0, { w0, w1 });
  await page.keyboard.type('wmctl click OK && wmctl wait nowin "About ctldemo" 8000 && echo ABT""1-DN\r');
  await waitOut('ABT1-DN');

  // ---- the Sounds applet mutes events ----
  await page.keyboard.type('ctlpanel &\r');
  // Boot barrier: the Sound applet icon resolving in the agent tree means
  // the hub is up + serving (the test_ctlpanel_e2e idiom).
  await page.keyboard.type('wmctl wait label Sound 15000 && echo CPL""-UP\r');
  await waitOut('CPL-UP', 30000);
  await page.keyboard.type('wmctl click Sounds && wmctl wait win "Sounds Properties" 8000 && echo SND""-UP\r');
  await waitOut('SND-UP');
  await page.keyboard.type('wmctl click "Enable event sounds"\r');
  // The click posts WM_COMMAND; the applet delta-writes the store — poll the
  // FILE for the mute key (waitFileHas idiom), then print it for the record.
  await page.keyboard.type('for i in $(seq 1 100); do grep -q "mute" /root/.config/sounds 2>/dev/null && break; sleep 0.1; done; cat /root/.config/sounds\r');
  await waitOut('mute\ton');
  check('mute checkbox wrote the user scheme store', true);
  // The vacuous leg this ticket retires: `w3 === w2` was satisfied equally
  // by "muting works" and by "the About dialog never opened". The wait on
  // `wmctl wait win` PROVES the dialog exists before sampling, so the check
  // now asserts silence-WITH-a-dialog, never silence-from-absence.
  const w2 = await waitQuiet();
  await page.keyboard.type('wmctl click About && wmctl wait win "About ctldemo" 8000 && echo ABT""2-UP\r');
  await waitOut('ABT2-UP');
  // Genuine no-marker settle: silence has no completion event. The dialog is
  // already OPEN (the wait above), so the beep — submitted at MessageBox
  // open — would by now be advancing the cursor; the unmuted leg's advance
  // lands well inside this window.
  await sleep(2500);
  const w3 = await wposAt();
  check('muted: MessageBox raise stays silent (dialog verifiably open)',
    w3 === w2, { w2, w3 });
  await page.keyboard.type('wmctl click OK && wmctl wait nowin "About ctldemo" 8000 && echo ABT""2-DN\r');
  await waitOut('ABT2-DN');

  // ---- re-enable: the applet's Test button plays again ----
  await page.keyboard.type('wmctl click "Enable event sounds"\r');
  // (grep "off", not "mute<TAB>off": a typed TAB is hush completion, and the
  // user store is a pure mute-key delta, so "off" is unambiguous there)
  await page.keyboard.type('for i in $(seq 1 100); do grep -q off /root/.config/sounds 2>/dev/null && break; sleep 0.1; done; echo UNMU""TE-OK\r');
  await waitOut('UNMUTE-OK');
  const w4 = await waitQuiet();
  await page.keyboard.type('wmctl click Test\r');
  const w5 = await waitWpos(w4, 10000);
  check('unmuted: the Test button plays', w5 !== w4, { w4, w5 });

  console.log(state.failures ? `FAILURES: ${state.failures}` : 'ALL OK');
  process.exitCode = state.failures ? 1 : 0;
} catch (e) {
  console.error('FATAL', e);
  try {
    const page = (await browser.contexts())[0]?.pages()[0];
    if (page) await page.screenshot({ path: path.join(__dirname, 'fail-shot-sounds.png') });
  } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
