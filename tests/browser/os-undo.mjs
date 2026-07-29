// todos/0135 browser acceptance, THE MAC CELL: the EDIT undo record driven
// the way jku hit the bug — a Mac host, where the keyboard-scheme
// auto-detect (hostkeys=mac -> seedHostKeyScheme -> /etc/keys scheme=macos)
// binds KA_UNDO to Cmd+Z, not Ctrl+Z. Every other undo test runs the
// windows cell (headless boots default hostPlatform 'other', and the
// kernel e2e pins scheme=windows for determinism); this file is the one
// that proves the cell the user actually exercises. No browser test passed
// hostKeys:'mac' before this — the coverage hole that let the original
// mac-scheme paste confusion ship.
//   - the auto-detect seed really lands (scheme=macos in /etc/keys)
//   - fresh notepad: Edit>Undo is GRAYED (no record yet — EM_CANUNDO gates
//     the item via NOTEPAD_InitMenuPopup at popup open)
//   - after typing, the reopened Edit popup shows Undo ENABLED
//   - Cmd+Z through the REAL page keyboard undoes the last insert, and a
//     second Cmd+Z re-applies it (the Windows undo/undo toggle)
// The chord rides page.keyboard Meta — the os-keybind file proves released
// GUI chords reach the app through the kernel ring; here the macos-scheme
// EDIT verb row resolves it to KA_UNDO -> EM_UNDO app-side.
//
// Usage: node os-undo.mjs
import { openOsSession } from './lib/os-harness.mjs';

// serverTries generous: serve.js re-bakes the image before listening when a
// bake input (user32.c here) changed, which outruns the default 5s wait.
const s = await openOsSession({
  port: 3280, hostKeys: 'mac', serverTries: 400, serverInterval: 500 });
const { page, check, setVt, waitOut } = s;

// A held-modifier chord through the REAL keyboard (0090 pacing: explicit
// down / gap / press / gap / up so the kernel sees the modifier on the key).
const chord = async (mods, key) => {
  for (const m of mods) await page.keyboard.down(m);
  await new Promise(r => setTimeout(r, 60));
  await page.keyboard.press(key, { delay: 50 });
  await new Promise(r => setTimeout(r, 60));
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};

// Run a shell line on VT1, optionally wait for a split-needle echo. -> VT2.
const sh = async (line, marker, ms = 20000) => {
  await setVt(1);
  await page.keyboard.type(line + '\r');
  if (marker) await waitOut(marker, ms);
  await setVt(2);
};

// Read the tty mirror fresh for one command's output.
const shRead = async (line, marker, ms = 20000) => {
  await setVt(1);
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type(line + '\r');
  await waitOut(marker, ms);
  const out = await page.evaluate(() => window.__osOut);
  await setVt(2);
  return out;
};

try {
  // ---- the auto-detect seed: hostkeys=mac must land scheme=macos ----
  const keys = await shRead(
    'cat /etc/keys; echo KEYS""-DUMPED', 'KEYS-DUMPED');
  check('hostkeys=mac seeds /etc/keys with scheme=macos (the auto-detect cell)',
    /scheme\s+macos/.test(keys), keys.slice(0, 200));

  // ---- notepad up, geometry from the agent view (no pixels) ----
  await sh('notepad &');
  const npOut = await shRead(
    'i=0; while [ $i -lt 30 ]; do wmctl list | grep -q Notepad && break; ' +
    'sleep 1; i=$((i+1)); done; wmctl list; echo NP""-UP', 'NP-UP', 120000);
  const npLine = npOut.split('\n').filter(l => /Notepad\s*$/.test(l)).pop() || '';
  const np = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(npLine);
  check('notepad listed', !!np, npLine);
  const [, , , NPX, NPY] = np ? np.map(Number) : [0, 0, 0, 0, 0];

  // The Edit-popup opener (the 0171 self-locating bar-click pattern): walk
  // candidate bar x positions until an open-popup label resolves.
  await sh('SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//") && echo SID""-SET',
    'SID-SET');
  await sh('openpopup() { for x in 8 30 50 70 90 110 130 150 170 190 210; do ' +
    'wmctl click $SID $x 10; ' +
    'for t in 1 2 3 4 5 6; do wmctl gettext "$1" >/dev/null 2>&1 && return 0; ' +
    'sleep 0.05; done; wmctl key $SID 41 27; done; return 1; } && echo OP""-SET',
    'OP-SET');

  // ---- fresh notepad: Undo grayed (no record yet) ----
  const menu0 = await shRead(
    'openpopup "Time/Date" && wmctl tree | grep "Undo"; echo MENU""0-DONE',
    'MENU0-DONE', 60000);
  check('fresh notepad: Edit popup lists Undo grayed (no record yet)',
    /text='Undo' grayed/.test(menu0), menu0.slice(-300));
  await sh('wmctl key $SID 41 27');               // ESC closes the popup

  // ---- type into the EDIT (real keyboard on VT2) ----
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + NPX + 120, rect.y + NPY + 60);
  await page.waitForTimeout(300);   // timing subject: EDIT focus-click settle (no marker)
  await page.keyboard.type('ab', { delay: 120 });
  await sh('wmctl wait text EDIT:0 ab 8000 && echo TYPED""-OK', 'TYPED-OK');

  // ---- after the edit: the reopened popup un-grays Undo ----
  const menu1 = await shRead(
    'openpopup "Time/Date" && wmctl tree | grep "Undo"; echo MENU""1-DONE',
    'MENU1-DONE', 60000);
  check('after an edit: Edit popup lists Undo enabled (EM_CANUNDO armed)',
    menu1.includes("text='Undo'") && !/text='Undo' grayed/.test(menu1),
    menu1.slice(-300));
  await sh('wmctl key $SID 41 27');               // ESC closes the popup

  // ---- Cmd+Z undoes; a second Cmd+Z re-applies (the toggle) ----
  await chord(['Meta'], 'KeyZ');
  const v1 = await shRead(
    'for i in $(seq 1 120); do wmctl gettext EDIT:0 | grep -qx a && break; ' +
    'sleep 0.05; done; echo "V1=[$(wmctl gettext EDIT:0)]"; echo UNDO""1-DONE',
    'UNDO1-DONE', 30000);
  check('Cmd+Z (macos-scheme KA_UNDO) undoes the last insert', v1.includes('V1=[a]'),
    v1.slice(-200));
  await chord(['Meta'], 'KeyZ');
  const v2 = await shRead(
    'for i in $(seq 1 120); do wmctl gettext EDIT:0 | grep -qx ab && break; ' +
    'sleep 0.05; done; echo "V2=[$(wmctl gettext EDIT:0)]"; echo UNDO""2-DONE',
    'UNDO2-DONE', 30000);
  check('a second Cmd+Z re-applies (the undo/undo toggle)', v2.includes('V2=[ab]'),
    v2.slice(-200));
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os undo mac-cell (browser)');
