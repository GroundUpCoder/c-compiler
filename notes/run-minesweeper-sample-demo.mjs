// Minesweeper SAMPLE tap-to-run demonstration driver (NOT a swept os-*.mjs;
// the deterministic tap chain is tests/kernel/test_minesweeper_sample_e2e.js).
// Boots gucOS in real Chromium off the freshly-baked v163 image and proves the
// SHIPPED gesture end-to-end, live:
//
//   double-click Desktop/Presentations -> fileman -> samples -> open
//   minesweeper-programming-rainbow.sh -> the headless-spawned script's
//   `[ -n "$TERM" ] || exec term "$0"` guard re-execs it into a term window
//   -> it curls the game source from raw.githubusercontent.com, `cc *.c`s
//   it IN-OS (libpng+zlib folded), and the game window opens.
//
// Needs live network (GitHub) and several minutes for the in-OS compile.
// Screenshots land in build/minesweeper-sample-shots/ (committed copies:
// tests/browser/shots-minesweeper-sample/).
//
// Usage: node notes/run-minesweeper-sample-demo.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from '../tests/browser/lib/os-harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { deskEntries, deskCell } = require('../tests/kernel/lib/drive.js');

const PORT = 3272;
const URL = osUrl(PORT);
const SHOT_DIR = 'build/minesweeper-sample-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();
const log = (m) => process.stdout.write(`[demo] ${m}\n`);

async function screenshot(page, name) {
  const dataUrl = await page.evaluate(() => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    t.getContext('2d').drawImage(c, 0, 0);
    return t.toDataURL('image/png');
  });
  const p = `${SHOT_DIR}/${name}.png`;
  fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
  log(`shot -> ${p}`);
  return p;
}

try {
  await waitForServer(URL, { tries: 400, interval: 500 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, waitScreen } = osHelpers(page);

  // Type a shell line on VT1 and wait for a marker it echoes (split-needle:
  // the typed echo must not satisfy its own wait — 0171).
  const shell = async (cmd, marker, ms = 30000) => {
    await setVt(1);
    await page.keyboard.type(cmd + '\r');
    if (marker) await page.waitForFunction(
      (n) => window.__osOut && window.__osOut.includes(n), marker,
      { timeout: ms, polling: 200 });
  };
  const mark = (m) => `${m[0]}""${m.slice(1)}`;   // split the typed needle

  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const scrH = (await page.evaluate(() => window.__osScreen)).h;
  await new Promise(r => setTimeout(r, 1500));   // EV_SCREEN quiesce (0091 trap)
  await screenshot(page, '0-desktop');

  // --- THE TAP: double-click the Presentations folder icon (live grid) ---
  const P = deskCell(deskEntries(), 'Presentations', scrH);
  log(`double-clicking Presentations at cell (${P.cx},${P.cy})`);
  await page.mouse.dblclick(rect.x + P.cx, rect.y + P.cy);
  await shell(`wmctl wait win "File Manager - /root/Desktop/Pr" 15000 && wmctl wait label Go 10000 && echo ${mark('FM-UP')}`, 'FM-UP', 30000);
  check('tap on Presentations opened fileman', true);

  // --- into samples/, open minesweeper-programming-rainbow.sh (keyboard
  // rows: the row-height-agnostic pattern of the kernel e2e) ---
  const SH = 'minesweeper-programming-rainbow.sh';
  const KEYS = [
    'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
    'wmctl click $SID 100 40', 'wmctl key $SID 74 1073741898',
    'wmctl key $SID 81 1073741905', 'wmctl key $SID 81 1073741905', 'wmctl key $SID 81 1073741905',
    'wmctl wait text LISTBOX:0 "> samples" 8000',
    'wmctl key $SID 40 13',
    `wmctl wait text LISTBOX:0 "${SH}" 8000`,
  ].join(' && ');
  await shell(`${KEYS} && echo ${mark('IN-SAMPLES')}`, 'IN-SAMPLES', 40000);
  await setVt(2);
  await screenshot(page, '1-samples-folder');
  // HOME alone (focus stays on the listbox): a repeat click at the same
  // coords can pair into LBN_DBLCLK and open the row twice.
  await shell(`wmctl key $SID 74 1073741898 && wmctl wait text LISTBOX:0 "> ${SH}" 8000 && wmctl key $SID 40 13 && echo ${mark('TAPPED')}`, 'TAPPED', 20000);
  check('opened ' + SH, true);

  // --- the tap spawned the script headless (no TERM in the desktop env);
  // its `[ -n "$TERM" ] || exec term "$0"` guard re-execs into a term
  // window — the window appearing IS the re-exec proof. The script's first
  // post-guard act is mkdir $HOME/minesweeper. ---
  await shell(`wmctl wait win term 20000 && echo ${mark('TERM-UP')}`, 'TERM-UP', 30000);
  check('a term window opened (the $TERM re-exec fired)', true);
  await shell(`n=0; while [ ! -d /root/minesweeper ] && [ $n -lt 60 ]; do sleep 0.5; n=$((n+1)); done; [ -d /root/minesweeper ] && echo ${mark('SCRIPT-RUNNING')}`, 'SCRIPT-RUNNING', 40000);
  check('the kit script is executing in the term', true);
  await setVt(2);
  await new Promise(r => setTimeout(r, 3000));   // let a little fetch progress render
  await screenshot(page, '2-term-fetching');

  // --- the long leg: curl 24 files -> sed -> cc *.c -> the game window.
  // The game titles its window "Minesweeper …". Poll from the shell. ---
  log('waiting for curl + in-OS cc + launch (this takes minutes)…');
  await shell(`n=0; while [ $n -lt 600 ]; do wmctl list | grep -q Minesweeper && break; sleep 1; n=$((n+1)); done; wmctl list | grep -q Minesweeper && echo ${mark('GAME-UP')}`, 'GAME-UP', 640000);
  check('the game window opened (curl -> cc -> run, all in-OS)', true);
  await shell(`wmctl list && echo ${mark('LIST-END')}`, 'LIST-END', 10000);
  log('windows:\n' + (await page.evaluate(() => window.__osOut.slice(-900))));
  await setVt(2);
  await new Promise(r => setTimeout(r, 2000));   // first frames
  await screenshot(page, '3-game-up');

  // one interaction: left-click a board cell, reshot
  const geom = await page.evaluate(() => {
    const m = window.__osOut.match(/(\d+)x(\d+)\+(\d+)\+(\d+)[^\n]*Minesweeper/);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  });
  if (geom) {
    await page.mouse.click(rect.x + geom.x + Math.floor(geom.w / 2),
                           rect.y + geom.y + geom.h - 80);
    await new Promise(r => setTimeout(r, 1000));
  }
  await screenshot(page, '4-game-clicked');

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
