// Ticket #79 browser acceptance: the host <-> gucOS clipboard bridge, both
// directions, in real Chromium with the clipboard permissions granted.
//   host -> gucOS: navigator.clipboard.writeText from the page (the "host
//     copy"), then the focus sync (a real window 'focus' dispatch — the
//     listener under test) lands it in the kernel slot; `clip -o` on VT1
//     prints it.
//   the clipboard SEAM (first-paste-fresh): host text copied with NO focus
//     event, then ONE Ctrl+V into notepad — the paste consumer parks in the
//     kernel on CLIP_GET, the page refreshes the slot inside the chord's
//     activation, and wmctl gettext must show the NEW text on the FIRST
//     paste (the old aim-at-next-paste refresh lost exactly this case). An
//     OSK-tap leg drives the same seam from real pointer taps.
//   gucOS -> host: `printf ... | clip` commits a copy; the CLIP_SET-commit
//     hook -> worker -> page writeText chain must land it where
//     navigator.clipboard.readText can see it.
//   loop guard: re-triggering the focus sync with the just-bridged text must
//     NOT push again (clipSynced de-dup — the __osClipFromHost counter stays).
//
// HONEST LIMIT (needs a human/real-browser check, like the 0149 macOS-Chrome
// keymap step): headless grantPermissions bypasses the real permission
// PROMPT, and Playwright pages are always "focused" — the user-facing flow
// (⌘Tab into the tab fires focus -> sync; Chrome's clipboard-read prompt on
// first sync) can't be exercised here. The plumbing both sides of those
// browser gates is what this file proves.
//
// Usage: node os-clipboard.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3253;
const S = await openOsSession({ port: PORT });
const { page, context, check, waitOut } = S;

try {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Land on VT1 for shell typing (boot auto-switched to VT2).
  await page.evaluate(() => window.__osVtSwitch(1));

  // ---- host -> gucOS via the focus sync ----
  await page.evaluate(() => navigator.clipboard.writeText('HOST-TO-GUC-79'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => (window.__osClipFromHost || 0) >= 1,
    { timeout: 10000, polling: 100 });
  check('focus sync read the host clipboard (__osClipFromHost)', true);
  // The needle arrives from the CLIPBOARD, not the typed line — clip -o
  // output satisfying the wait proves the kernel slot really holds it.
  await page.keyboard.type('clip -o\r');
  await waitOut('HOST-TO-GUC-79', 15000);
  check('clip -o prints the host copy (host -> gucOS)', true);

  // ---- gucOS -> host via the commit hook ----
  await page.keyboard.type("printf 'GUC-TO-HOST-79' | clip\r");
  await page.waitForFunction(() => window.__osClipLast === 'GUC-TO-HOST-79',
    { timeout: 15000, polling: 100 });
  check('gucOS copy reached the page (__osClipLast)', true);
  await page.waitForFunction(
    () => navigator.clipboard.readText().then((t) => t === 'GUC-TO-HOST-79'),
    { timeout: 10000, polling: 200 });
  check('host clipboard holds the gucOS copy (gucOS -> host)', true);

  // ---- loop guard: the bridged text must not bounce back ----
  const pushes = await page.evaluate(() => window.__osClipFromHost || 0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await new Promise((r) => setTimeout(r, 800));   // give a wrong push time to land
  const pushes2 = await page.evaluate(() => window.__osClipFromHost || 0);
  check('focus sync de-dups its own writeText (loop guard)', pushes2 === pushes,
    { pushes, pushes2 });

  // ---- The clipboard seam: the FIRST paste is fresh ----
  // The old chord-keydown pre-read (aim-at-the-NEXT-paste) is DELETED; a
  // paste consumer now parks in the kernel on CLIP_GET and the page
  // refreshes the slot inside the chord's still-live activation. The probe
  // is the whole bug: host text copied with NO focus event (the user copied
  // without leaving the tab), then ONE paste chord — the pasted text must
  // be the new host text, not the stale slot ('GUC-TO-HOST-79' from the leg
  // above is exactly what a stale first paste would produce here).
  await page.keyboard.type('notepad &\r');
  await page.waitForTimeout(800);   // timing subject: the async job-notice trap (no distinct marker)
  await page.keyboard.type('i=0; while [ $i -lt 30 ]; do wmctl list | grep -q Notepad && break; sleep 1; i=$((i+1)); done; sleep 1; wmctl list; echo NP-""UP\r');
  await waitOut('NP-UP', 120000);
  const npLine = (await page.evaluate(() =>
    window.__osOut.split('\n').filter(l => /Notepad\s*$/.test(l)))).pop() || '';
  const np = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(npLine);
  check('notepad listed', !!np, npLine);
  const [NPW, , NPX, NPY] = np ? np.slice(1).map(Number) : [0, 0, 0, 0];
  // Host copy AFTER boot, with no focus dispatch: only the seam can land it.
  await page.evaluate(() => navigator.clipboard.writeText('FIRST-PASTE-FRESH-79'));
  const clipRead0 = await page.evaluate(() => window.__osClipRead || 0);
  await page.evaluate(() => window.__osVtSwitch(2));
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);
  await clickAt(NPX + Math.min(120, NPW - 20), NPY + 60);
  await page.waitForTimeout(300);   // timing subject: EDIT focus-click settle (no marker)
  // Paced chord (the os-shell PACED-input rule: zero-delay floods the pump).
  await page.keyboard.down('Control');
  await page.waitForTimeout(100);   // timing subject: paced Ctrl chord
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(100);   // timing subject: paced Ctrl chord
  await page.keyboard.up('Control');
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('wmctl gettext EDIT:0; echo GT1""-DONE\r');
  await waitOut('GT1-DONE', 30000);
  const got1 = await page.evaluate(() => window.__osOut);
  check('FIRST paste delivered the fresh host text (the seam, not the stale slot)',
    got1.includes('FIRST-PASTE-FRESH-79'), got1.slice(0, 300));
  check('first paste is NOT the stale slot text', !got1.includes('GUC-TO-HOST-79'),
    got1.slice(0, 300));
  check('the parked CLIP_GET drove a clip-read round-trip (probe)',
    await page.evaluate((n) => (window.__osClipRead || 0) > n, clipRead0), true);

  // ---- OSK paste chord on VT2: the same seam from a REAL pointer tap
  // (its activation is what legalizes readText on iOS — synthetic
  // __osOskTap probes carry no activation, so this leg drives the actual
  // key elements with the mouse). Sticky Ctrl arms one-shot, v fires the
  // chord into the focused notepad, the parked CLIP_GET refreshes fresh.
  await page.evaluate(() => navigator.clipboard.writeText('OSK-PASTE-FRESH-79'));
  await page.evaluate(() => window.__osVtSwitch(2));
  await page.evaluate(() => window.__osOskToggle(true));
  await page.waitForTimeout(400);   // timing subject: OSK open re-lays the pane (no marker)
  await page.click('#osk [data-k="Ctrl"]');
  await page.waitForTimeout(150);   // timing subject: paced OSK taps (input-pump rule)
  await page.click('#osk [data-k="v"]');
  await page.waitForTimeout(300);   // timing subject: paste + one-shot disarm settle
  await page.evaluate(() => window.__osOskToggle(false));
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('wmctl gettext EDIT:0; echo GT2""-DONE\r');
  await waitOut('GT2-DONE', 30000);
  const got2 = await page.evaluate(() => window.__osOut);
  check('OSK Ctrl+V tap pasted the fresh host text through the seam',
    got2.includes('OSK-PASTE-FRESH-79'), got2.slice(0, 300));
} catch (e) {
  S.fail(e);
} finally {
  await S.close();
}
S.finish('os-clipboard');
