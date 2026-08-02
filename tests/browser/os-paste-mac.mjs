// Ticket #96 (todos/0432) browser acceptance, THE MAC CELL (hostKeys:'mac',
// the os-undo.mjs rig): ⌘V paste legibility + robustness the way a Mac user
// hits it. The keymap itself is a CLOSED DECISION (todos/KEYMAP.md — ⌘
// carries the verbs, Ctrl stays reserved); everything here is truth-in-
// labeling and robustness under that policy.
//   - /run/host-platform: the browser boot path persists the 'mac' verdict.
//   - permission-free paste: a text-flavored paste EVENT is posted as the
//     kernel slot BEFORE the forwarded chord — asserted with clipboard-read
//     NEVER granted, so the readText path would be DENIED: the pasted text
//     can only have arrived through the event flavor (no prompt, no
//     readText). The event is synthesized (the os-clipboard.mjs file-leg
//     precedent — Playwright cannot drive the host clipboard's native paste
//     command deterministically); everything downstream is the product path:
//     carve-out arm, slot publish, FIFO chord forward, EDIT paste.
//   - the D6 dedup memos hold: a second identical paste re-pastes the SLOT
//     (no re-post — __osClipEvent stays), text arrives once per chord.
//   - the menu accel column tells the truth in the mac cell: notepad's Edit
//     popup lists Paste with accel='Cmd+V' (the menucore draw-layer rewrite,
//     reported through the agent tree's accel field).
//   - the STALE windows-scheme volume cell: rm /etc/keys (the pre-v138 root
//     never got the macos seed), relaunch notepad — ⌘V still pastes via the
//     implicit host row, with no scheme flip and no ~/.config/keys write.
//
// Usage: node os-paste-mac.mjs
import { openOsSession } from './lib/os-harness.mjs';

// serverTries generous: serve.js re-bakes the image before listening when a
// bake input changed (user32.c/menucore.c/keys.h here).
const s = await openOsSession({
  port: 3327, hostKeys: 'mac', serverTries: 400, serverInterval: 500 });
const { page, check, waitOut } = s;

// Run a shell line on VT1, optionally wait for a split-needle echo. -> VT2.
const sh = async (line, marker, ms = 20000) => {
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.keyboard.type(line + '\r');
  if (marker) await waitOut(marker, ms);
  await page.evaluate(() => window.__osVtSwitch(2));
};

// Read the tty mirror fresh for one command's output.
const shRead = async (line, marker, ms = 20000) => {
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type(line + '\r');
  await waitOut(marker, ms);
  const out = await page.evaluate(() => window.__osOut);
  await page.evaluate(() => window.__osVtSwitch(2));
  return out;
};

// The product paste path from the page side: arm the carve-out with the mac
// chord's key events (Meta down, then the carved V — metaKey set, so wm/user32
// see the GUI modifier on the forwarded record), then deliver a text-flavored
// paste event. The keyup releases Meta afterwards.
const pasteText = (text) => page.evaluate((t) => {
  const scr = document.getElementById('screen');
  scr.dispatchEvent(new KeyboardEvent('keydown',
    { code: 'MetaLeft', key: 'Meta', metaKey: true, bubbles: true }));
  scr.dispatchEvent(new KeyboardEvent('keydown',
    { code: 'KeyV', key: 'v', metaKey: true, bubbles: true }));
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  scr.dispatchEvent(new KeyboardEvent('keyup',
    { code: 'KeyV', key: 'v', metaKey: true, bubbles: true }));
  scr.dispatchEvent(new KeyboardEvent('keyup',
    { code: 'MetaLeft', key: 'Meta', bubbles: true }));
}, text);

try {
  // NB: clipboard-read is deliberately NEVER granted in this session — a
  // readText from the page would reject, so a successful paste below proves
  // the permission-free event path.

  // ---- the persisted host verdict (browser boot path) ----
  const verdict = await shRead('cat /run/host-platform; echo HP""-DUMPED', 'HP-DUMPED');
  check('browser boot persists /run/host-platform = mac', /\bmac\b/.test(verdict),
    verdict.slice(0, 200));

  // ---- notepad up, EDIT focused ----
  await sh('notepad &');
  const npOut = await shRead(
    'i=0; while [ $i -lt 30 ]; do wmctl list | grep -q Notepad && break; ' +
    'sleep 1; i=$((i+1)); done; wmctl list; echo NP""-UP', 'NP-UP', 120000);
  const npLine = npOut.split('\n').filter(l => /Notepad\s*$/.test(l)).pop() || '';
  const np = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(npLine);
  check('notepad listed', !!np, npLine);
  const [, , , NPX, NPY] = np ? np.map(Number) : [0, 0, 0, 0, 0];
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + NPX + 120, rect.y + NPY + 60);
  await page.waitForTimeout(300);   // timing subject: EDIT focus-click settle (no marker)

  // ---- permission-free ⌘V: the event text is the slot ----
  await pasteText('EVENT-TEXT-96');
  const got1 = await shRead(
    'for i in $(seq 1 120); do wmctl gettext EDIT:0 | grep -q "EVENT-TEXT-96" && break; ' +
    'sleep 0.05; done; echo "G1=[$(wmctl gettext EDIT:0)]"; echo GT""1-DONE',
    'GT1-DONE', 30000);
  check('⌘V pastes the paste-event text flavor (clipboard-read NEVER granted)',
    got1.includes('G1=[EVENT-TEXT-96]'), got1.slice(-200));
  check('the event posted the slot exactly once (__osClipEvent probe)',
    await page.evaluate(() => window.__osClipEvent === 1),
    await page.evaluate(() => window.__osClipEvent));

  // ---- D6 memos: an identical second paste re-pastes the slot, no re-post ----
  await pasteText('EVENT-TEXT-96');
  const got2 = await shRead(
    'for i in $(seq 1 120); do wmctl gettext EDIT:0 | grep -q "EVENT-TEXT-96EVENT-TEXT-96" && break; ' +
    'sleep 0.05; done; echo "G2=[$(wmctl gettext EDIT:0)]"; echo GT""2-DONE',
    'GT2-DONE', 30000);
  check('a second identical paste pastes once more (no double-paste, no drop)',
    got2.includes('G2=[EVENT-TEXT-96EVENT-TEXT-96]'), got2.slice(-200));
  check('the clipSynced memo suppressed a duplicate slot post (__osClipEvent still 1)',
    await page.evaluate(() => window.__osClipEvent === 1),
    await page.evaluate(() => window.__osClipEvent));

  // ---- the mac-cell menu accel column: Paste advertises Cmd+V ----
  await sh('SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//") && echo SID""-SET',
    'SID-SET');
  await sh('openpopup() { for x in 8 30 50 70 90 110 130 150 170 190 210; do ' +
    'wmctl click $SID $x 10; ' +
    'for t in 1 2 3 4 5 6; do wmctl gettext "$1" >/dev/null 2>&1 && return 0; ' +
    'sleep 0.05; done; wmctl key $SID 41 27; done; return 1; } && echo OP""-SET',
    'OP-SET');
  const menu = await shRead(
    'openpopup "Time/Date" && wmctl tree | grep "text=.Paste."; echo MENU""-DONE',
    'MENU-DONE', 60000);
  check('macos scheme: the Edit popup draws accel Cmd+V (menucore rewrite)',
    /menuitem [^\n]*text='Paste'[^\n]*accel='Cmd\+V'/.test(menu), menu.slice(-300));
  await sh('wmctl key $SID 41 27');               // ESC closes the popup

  // ---- the STALE windows-scheme volume cell ----
  // rm the seeded /etc/keys (the pre-v138 root never had one), relaunch
  // notepad so its first config read sees the baked windows default, and
  // ⌘V — injected in-OS so this cell is scheme mechanics, not browser
  // key-routing (the legs above already proved that) — must still paste.
  // pkill, not wmctl close: the edited buffer would raise the save-changes
  // prompt and the old window would linger, making EDIT:0 ambiguous.
  await sh('rm -f /etc/keys && pkill notepad; wmctl wait nowin Notepad 8000; echo RM""-DONE',
    'RM-DONE');
  await sh('notepad &');
  await sh('i=0; while [ $i -lt 30 ]; do wmctl list | grep -q Notepad && break; ' +
    'sleep 1; i=$((i+1)); done; wmctl wait label EDIT:0 12000; echo NP""2-UP', 'NP2-UP', 120000);
  const stale = await shRead(
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//"); ' +
    'printf "STALE-VOL-96" | clip; wmctl settext EDIT:0 ""; ' +
    'wmctl key $NSID 25 118 1024; ' +
    'wmctl wait text EDIT:0 "STALE-VOL-96" 8000; ' +
    'echo "SV=[$(wmctl gettext EDIT:0)]"; ' +
    'echo "ETC=[$(cat /etc/keys 2>&1)]"; ' +
    'echo "USR=[$(ls /root/.config/keys 2>&1)]"; echo SV""-DONE',
    'SV-DONE', 60000);
  check('stale windows-scheme volume: ⌘V still pastes (the implicit host row)',
    stale.includes('SV=[STALE-VOL-96]'), stale.slice(-400));
  check('no scheme flip: /etc/keys stays absent', /ETC=\[[^\]]*No such file/.test(stale),
    stale.slice(-400));
  check('no user-config write: ~/.config/keys stays absent',
    /USR=\[[^\]]*No such file/.test(stale), stale.slice(-400));
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os paste mac-cell (browser)');
