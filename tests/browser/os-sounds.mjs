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
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3207;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  // serve.js re-bakes a stale system image BEFORE listening (0082) — allow
  // it the full bake, not just a settle.
  for (let i = 0; i < 600; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await sleep(200); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut.includes(n), needle, { timeout: ms || 30000, polling: 200 });
  const audioCtl = () => page.evaluate(() =>
    Array.from(new Int32Array(window.__osAudioSab, 0, 4)));
  const wposAt = async () => (await audioCtl())[0];

  // ---- the startup chime, pre-gesture: the wm service submits it at
  // desktop-ready (its worker boots ~1s AFTER the page's 'ready' — wait,
  // don't sample) and the pump mixes it into the output ring; nothing
  // drains until the gesture, so queuedBytes parks at the pump's target.
  // NB no typing/clicking before this — a gesture would start draining.
  await page.waitForFunction(() => window.__osAudioSab &&
    new Int32Array(window.__osAudioSab, 0, 4)[1] > 0, { timeout: 20000, polling: 100 });
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
  }, { timeout: 30000, polling: 200 });
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(rect.x + rect.w - 200, rect.y + 200);   // bare desktop
  await page.waitForFunction(() => window.__osAudio === 'playing', { timeout: 10000, polling: 100 });
  check('audio resumed on the gesture', true);
  const wChime = await wposAt();
  await sleep(4000);                       // the ~2.2s chime finishes
  const wEnd = await wposAt();
  await sleep(1500);
  const wQuiet = await wposAt();
  check('chime played out once and the mixer went quiet',
    wEnd !== ctl0[0] && wQuiet === wEnd, { wChime, wEnd, wQuiet });

  // ---- MessageBox raise beeps (MessageBeep -> PlaySound SystemDefault) ----
  await setVt(1);
  await sleep(500);
  await page.keyboard.type('ctldemo &\r');
  await waitOut('ctldemo: ready', 120000);
  await sleep(800);                        // hush job-notice settle (0089)
  const w0 = await wposAt();
  await page.keyboard.type('wmctl click About\r');
  await sleep(2000);
  const w1 = await wposAt();
  check('MessageBox raise beeps (producer cursor advanced)', w1 !== w0, { w0, w1 });
  await page.keyboard.type('wmctl click OK\r');
  await sleep(2000);                       // dismiss + let the clip drain out

  // ---- the Sounds applet mutes events ----
  await page.keyboard.type('ctlpanel &\r');
  await sleep(1500);
  await page.keyboard.type('wmctl click Sounds\r');
  await sleep(1200);
  await page.keyboard.type('wmctl click "Enable event sounds"\r');
  await sleep(1200);
  await page.keyboard.type('cat /root/.config/sounds\r');
  await waitOut('mute\ton');
  check('mute checkbox wrote the user scheme store', true);
  const w2 = await wposAt();
  await page.keyboard.type('wmctl click About\r');
  await sleep(2500);
  const w3 = await wposAt();
  check('muted: MessageBox raise stays silent', w3 === w2, { w2, w3 });
  await page.keyboard.type('wmctl click OK\r');
  await sleep(1000);

  // ---- re-enable: the applet's Test button plays again ----
  await page.keyboard.type('wmctl click "Enable event sounds"\r');
  await sleep(1200);
  const w4 = await wposAt();
  await page.keyboard.type('wmctl click Test\r');
  await sleep(2000);
  const w5 = await wposAt();
  check('unmuted: the Test button plays', w5 !== w4, { w4, w5 });

  console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
  process.exitCode = failures ? 1 : 0;
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
