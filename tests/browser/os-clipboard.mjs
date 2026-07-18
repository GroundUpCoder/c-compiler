// Ticket #79 browser acceptance: the host <-> gucOS clipboard bridge, both
// directions, in real Chromium with the clipboard permissions granted.
//   host -> gucOS: navigator.clipboard.writeText from the page (the "host
//     copy"), then the focus sync (a real window 'focus' dispatch — the
//     listener under test) lands it in the kernel slot; `clip -o` on VT1
//     prints it. A second leg drives the VT2 paste-chord refresh (Ctrl+V on
//     the canvas) the same way.
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

  // ---- VT2 paste-chord refresh: Ctrl+V on the canvas re-reads the host ----
  await page.evaluate(() => navigator.clipboard.writeText('HOST-CHORD-79'));
  await page.evaluate(() => window.__osVtSwitch(2));
  await page.click('#screen', { position: { x: 400, y: 200 } });
  await page.keyboard.press('Control+KeyV');
  await page.waitForFunction((n) => (window.__osClipFromHost || 0) > n, pushes2,
    { timeout: 10000, polling: 100 });
  check('paste chord on the desktop re-reads the host clipboard', true);
  await page.evaluate(() => window.__osVtSwitch(1));
  await page.keyboard.type('clip -o\r');
  await waitOut('HOST-CHORD-79', 15000);
  check('chord-synced text reaches the kernel slot', true);
} catch (e) {
  S.fail(e);
} finally {
  await S.close();
}
S.finish('os-clipboard');
