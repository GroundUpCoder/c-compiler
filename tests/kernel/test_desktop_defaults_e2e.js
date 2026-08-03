#!/usr/bin/env node
// Lane D acceptance (win32 source-lib design §6, todos/OS.md): the additive
// "add default desktop icons" reconcile.
//
//   - foldDesktopDefaults (os-common.js) bakes the manifest's /root/Desktop
//     user set as a system twin tree at /usr/share/desktop/default (links
//     stay links, launcher scripts keep content+mode, deck data rides as
//     bytes) — asserted directly against the booted image.
//   - /usr/bin/desktop-defaults (os/deskdefaults.c) re-plants ADDITIVELY:
//     deleted defaults come back (a top-level link, an executable launcher
//     script and a data file each nested inside the user's existing
//     Presentations/), user files on the Desktop and INSIDE a default
//     subfolder survive untouched, and a user file squatting a default
//     NAME is never overwritten (skip, counted kept). Re-run prints
//     `added 0` (idempotent). Counts derive from os/image.json (the
//     0166 rule: a new seeded icon must not break this test).
//   - Phase 2: an installed desktop-eligible package (control.json
//     `desktop: {cmd}`, design §5) missing its icon gets it back —
//     IGNORING the desktop_shortcuts install-time flag (explicit user
//     action) — and the plant is recorded in the gucman DB record so
//     remove's reverse replay unplants it; a field-less package never
//     gets an icon.
//   - The wm.c desktop ctx-menu "Add Default Icons" row (§6.3) drives the
//     same tool fire-and-forget.
//
// Run: node tests/kernel/test_desktop_defaults_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section, bakedSeedPlants } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The default-set size, derived from the manifest like drive.js deskEntries
// (files AND dirs under /root/Desktop/ — the walk visits every one; the
// dirs are the additive-merge recursion points).
const u = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8')).user;
const DEF_FILES = Object.keys(u.files)
  .filter((p) => p.startsWith('/root/Desktop/'));
const DEF_DIRS = (u.dirs || []).filter((p) => p.startsWith('/root/Desktop/'));
// Phase 3 (the BAKED seed reconcile) walks every folded package's declared
// seeds too, and on a fresh boot they are all already planted — so each of
// their nodes lands in the same `kept` counter. Derived, per package, from
// the definition + the payload tree (drive.js): a new seed-carrying package
// must move these counts on its own, not break this test.
const BAKED_SEED_NODES = bakedSeedPlants().reduce((n, p) => n + p.dests.reduce(
  (m, base) => m
    + p.files.filter((f) => f === base || f.startsWith(base + '/')).length
    + p.dirs.filter((d) => d === base || d.startsWith(base + '/')).length, 0), 0);
const TOTAL = DEF_FILES.length + DEF_DIRS.length + BAKED_SEED_NODES;
// The three deleted defaults the tool must restore — each a different
// entry kind (link / content script / nested bin data). The script kind
// is the minesweeper sample since #434 removed the top-level sameboy
// launchers (the last top-level content scripts). If a future manifest
// edit renames one, fail loud here rather than mysteriously.
const SAMPLE =
  '/root/Desktop/Presentations/samples/minesweeper-programming-rainbow.sh';
for (const p of ['/root/Desktop/doom', SAMPLE,
                 '/root/Desktop/Presentations/gucOS/gucos.deck']) {
  if (!u.files[p]) throw new Error('manifest no longer seeds ' + p +
    ' — pick another fixture for this test');
}

const { dir: tmp, image } = freshImage('os-deskdef-');

const script = [
  // ---- the baked default rendering is in the sealed blob ----
  'echo "==tree L$(readlink /usr/share/desktop/default/doom)-END"',
  'test -d "/usr/share/desktop/default/Presentations/MagicPoint Tutorial" && echo TREE-DIR-OK',
  'test -s "/usr/share/desktop/default/Presentations/gucOS/gucos.deck" && echo TREE-DATA-OK',
  `test -x "${SAMPLE.replace('/root/Desktop', '/usr/share/desktop/default')}" && echo TREE-MODE-OK`,
  // ---- leg A: delete three defaults (link / script / nested data), drop
  //      user files, squat a default name ----
  'rm /root/Desktop/doom',
  `rm "${SAMPLE}"`,
  'rm "/root/Desktop/Presentations/gucOS/gucos.deck"',
  'rm /root/Desktop/notepad',
  'printf mine > /root/Desktop/notepad',            // name clash: user file wins
  'printf usernote > /root/Desktop/usernote.txt',
  'printf userdeck > "/root/Desktop/Presentations/userdeck.mgp"',
  'echo ==dd1',
  'desktop-defaults',
  'echo "RC=$?"',
  'echo ==dd1end',
  'echo "==doom L$(readlink /root/Desktop/doom)-END"',
  `test -x "${SAMPLE}" && grep -q Minesweeper "${SAMPLE}" && echo SCRIPT-BACK`,
  'test -s "/root/Desktop/Presentations/gucOS/gucos.deck" && echo DECK-BACK',
  'echo "==squat $(cat /root/Desktop/notepad)-END"',
  'echo "==unote $(cat /root/Desktop/usernote.txt)-END"',
  'echo "==udeck $(cat "/root/Desktop/Presentations/userdeck.mgp")-END"',
  // ---- leg B: idempotent re-run ----
  'echo ==dd2',
  'desktop-defaults',
  'echo "RC=$?"',
  'echo ==dd2end',
  // ---- leg C: phase 2 — installed packages by DB record + control.json ----
  'mkdir -p /opt/fakepkg /opt/fakecli /var/lib/gucman /usr/local/bin',
  'printf "#!/bin/sh\\necho fake\\n" > /usr/local/bin/fakecmd',
  'chmod +x /usr/local/bin/fakecmd',
  'printf "{\\"name\\":\\"fakepkg\\",\\"version\\":\\"1.0\\",\\"bin\\":{\\"fakecmd\\":\\"x\\"},\\"desktop\\":{\\"cmd\\":\\"fakecmd\\"}}" > /opt/fakepkg/control.json',
  'printf "{\\"name\\":\\"fakepkg\\",\\"version\\":\\"1.0\\"}" > /var/lib/gucman/fakepkg.json',
  // a bin-bearing but FIELD-LESS package: never an icon (the §5 rule)
  'printf "{\\"name\\":\\"fakecli\\",\\"version\\":\\"1.0\\",\\"bin\\":{\\"fakecli\\":\\"x\\"}}" > /opt/fakecli/control.json',
  'printf "{\\"name\\":\\"fakecli\\",\\"version\\":\\"1.0\\"}" > /var/lib/gucman/fakecli.json',
  // the install-time global flag OFF — the explicit action must override it
  'rm -f /var/lib/gucman/desktop_shortcuts',
  'echo ==dd3',
  'desktop-defaults',
  'echo "RC=$?"',
  'echo ==dd3end',
  'echo "==fakeicon L$(readlink /root/Desktop/fakepkg)-END"',
  'test ! -e /root/Desktop/fakecli && echo NO-CLI-ICON',
  'grep -q "/root/Desktop/fakepkg" /var/lib/gucman/fakepkg.json && echo DB-REC-OK',
  'echo ==dd4',
  'desktop-defaults',
  'echo ==dd4end',
  // ---- leg D: the wm.c desktop ctx-menu row fires the tool ----
  'rm /root/Desktop/doom',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'wmctl click $DSID 400 300 3',
  'wmctl wait win ctxmenu 8000',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 30 106',                   // Add Default Icons (row 3)
  'wmctl wait nowin ctxmenu 8000',               // fired + dismissed
  // the spawned tool re-plants asynchronously — poll the file marker
  'for i in $(seq 1 100); do test -L /root/Desktop/doom && break; sleep 0.1; done',
  'test -L /root/Desktop/doom && echo CTX-RESTORED',
  // ---- leg E: phase 2 re-plants missing `seed` CONTENT (gucman content-
  //      resource design §3.4) and records it back into the DB ----
  'mkdir -p /opt/fakeseed/demos/sub',
  'printf hello > /opt/fakeseed/demos/index.html',
  'printf deep > /opt/fakeseed/demos/sub/deep.txt',
  'printf note > /opt/fakeseed/note.txt',
  'printf "{\\"name\\":\\"fakeseed\\",\\"version\\":\\"1.0\\",\\"seed\\":{\\"Demos\\":\\"demos\\",\\"note.txt\\":\\"note.txt\\"}}" > /opt/fakeseed/control.json',
  'printf "{\\"name\\":\\"fakeseed\\",\\"version\\":\\"1.0\\"}" > /var/lib/gucman/fakeseed.json',
  'echo ==dd5',
  'desktop-defaults',
  'echo "RC=$?"',
  'echo ==dd5end',
  'echo "==sidx $(cat /root/Demos/index.html)-END"',
  'echo "==sdeep $(cat /root/Demos/sub/deep.txt)-END"',
  'echo "==snote $(cat /root/note.txt)-END"',
  'grep -q "/root/Demos/index.html" /var/lib/gucman/fakeseed.json && echo SEED-DB-OK',
  'grep -q "/root/Demos/sub" /var/lib/gucman/fakeseed.json && echo SEEDDIR-DB-OK',
  // ---- leg F: idempotent, then a deleted seed comes back while an edited
  //      one is kept ----
  'echo ==dd6',
  'desktop-defaults',
  'echo ==dd6end',
  'printf MINE > /root/Demos/index.html',
  'rm /root/note.txt',
  'echo ==dd7',
  'desktop-defaults',
  'echo ==dd7end',
  'echo "==sedit $(cat /root/Demos/index.html)-END"',
  'echo "==sback $(cat /root/note.txt)-END"',
  // ---- leg G: gucman remove unplants reconcile-planted seeds exactly like
  //      install-planted ones — pristine go, the edited copy stays ----
  'echo ==dd8',
  'gucman remove fakeseed; echo "RC=$?"',
  'test ! -e /root/note.txt && echo RECON-PRISTINE-GONE',
  'test ! -e /root/Demos/sub && echo RECON-EMPTYDIR-GONE',
  'echo "==skept $(cat /root/Demos/index.html)-END"',
  'echo ==dd8end',
  '',
].join('\n');

const r = driveBoot(script, { image });
const out = r.stdout;

// ---- the baked rendering ----
check('blob carries the default link as a LINK',
  out.includes('==tree L/usr/bin/doom-END'), section(out, 'tree'));
check('blob carries a nested default dir', out.includes('TREE-DIR-OK'));
check('blob carries nested deck data', out.includes('TREE-DATA-OK'));
check('blob keeps the launcher-script mode (0755)', out.includes('TREE-MODE-OK'));

// ---- leg A: the additive reconcile ----
const dd1 = out.split('==dd1\n')[1] ? out.split('==dd1\n')[1].split('==dd1end')[0] : '';
check(`first run: added 3, kept ${TOTAL - 3} existing (counts from the manifest)`,
  dd1.includes(`desktop-defaults: added 3, kept ${TOTAL - 3} existing`), dd1);
check('first run exits 0', dd1.includes('RC=0'), dd1);
check('deleted doom link is back (as a symlink)',
  out.includes('==doom L/usr/bin/doom-END'), section(out, 'doom'));
check('deleted launcher script is back, executable, right content',
  out.includes('SCRIPT-BACK'));
check('deleted nested deck data is back inside the existing folder',
  out.includes('DECK-BACK'));
check('a user file squatting a default name is NEVER overwritten',
  out.includes('==squat mine-END'), section(out, 'squat'));
check('user file on the Desktop untouched',
  out.includes('==unote usernote-END'), section(out, 'unote'));
check('user file INSIDE the default subfolder untouched (additive merge)',
  out.includes('==udeck userdeck-END'), section(out, 'udeck'));

// ---- leg B: idempotence ----
const dd2 = out.split('==dd2\n')[1] ? out.split('==dd2\n')[1].split('==dd2end')[0] : '';
check(`re-run: added 0, kept ${TOTAL} existing (idempotent)`,
  dd2.includes(`desktop-defaults: added 0, kept ${TOTAL} existing`), dd2);
check('re-run exits 0', dd2.includes('RC=0'), dd2);

// ---- leg C: phase 2 (installed packages) ----
const dd3 = out.split('==dd3\n')[1] ? out.split('==dd3\n')[1].split('==dd3end')[0] : '';
check(`eligible package icon planted (added 1, flag off — explicit action overrides)`,
  dd3.includes(`desktop-defaults: added 1, kept ${TOTAL} existing`), dd3);
check('icon targets /usr/local/bin/<cmd>',
  out.includes('==fakeicon L/usr/local/bin/fakecmd-END'), section(out, 'fakeicon'));
check('field-less bin-bearing package gets NO icon (§5)',
  out.includes('NO-CLI-ICON'));
check('plant recorded in the gucman DB (remove will unplant)',
  out.includes('DB-REC-OK'));
const dd4 = out.split('==dd4\n')[1] ? out.split('==dd4\n')[1].split('==dd4end')[0] : '';
check(`package re-run: added 0, kept ${TOTAL + 1} existing`,
  dd4.includes(`desktop-defaults: added 0, kept ${TOTAL + 1} existing`), dd4);

// ---- leg D: the ctx-menu row ----
check('desktop menu "Add Default Icons" row restores the deleted icon',
  out.includes('CTX-RESTORED'));

// ---- legs E-G: the `seed` content reconcile (design §3.4) ----
// Baseline at this point: TOTAL phase-1 nodes + the fakepkg icon from leg C.
const BASE = TOTAL + 1;
const dd5 = out.split('==dd5\n')[1] ? out.split('==dd5\n')[1].split('==dd5end')[0] : '';
check(`seed reconcile plants both missing dests (added 2, kept ${BASE})`,
  dd5.includes(`desktop-defaults: added 2, kept ${BASE} existing`), dd5);
check('seed reconcile exits 0', dd5.includes('RC=0'), dd5);
check('a directory seed is re-planted, nested file and all',
  out.includes('==sidx hello-END') && out.includes('==sdeep deep-END'),
  section(out, 'sidx') + section(out, 'sdeep'));
check('a single-file seed is re-planted', out.includes('==snote note-END'), section(out, 'snote'));
check('the reconcile plant is recorded in the gucman DB (remove will unplant)',
  out.includes('SEED-DB-OK'));
check('the dirs the reconcile created are recorded too', out.includes('SEEDDIR-DB-OK'));

// A re-run finds all 5 seeded nodes present: 1 dir + 1 file + 1 subdir +
// 1 nested file + the single-file seed.
const dd6 = out.split('==dd6\n')[1] ? out.split('==dd6\n')[1].split('==dd6end')[0] : '';
check(`seed reconcile is idempotent (added 0, kept ${BASE + 5})`,
  dd6.includes(`desktop-defaults: added 0, kept ${BASE + 5} existing`), dd6);

const dd7 = out.split('==dd7\n')[1] ? out.split('==dd7\n')[1].split('==dd7end')[0] : '';
check(`a deleted seed comes back, the other 4 nodes kept (added 1, kept ${BASE + 4})`,
  dd7.includes(`desktop-defaults: added 1, kept ${BASE + 4} existing`), dd7);
check('an EDITED seed is never overwritten by the reconcile',
  out.includes('==sedit MINE-END'), section(out, 'sedit'));
check('the deleted seed is back with the package\'s content',
  out.includes('==sback note-END'), section(out, 'sback'));

const dd8 = out.split('==dd8\n')[1] ? out.split('==dd8\n')[1].split('==dd8end')[0] : '';
check('gucman remove succeeds over reconcile-planted seeds', dd8.includes('RC=0'), dd8);
check('remove unplants the pristine reconcile-planted seed',
  dd8.includes('RECON-PRISTINE-GONE'), dd8);
check('remove rmdirs the empty dir the reconcile created',
  dd8.includes('RECON-EMPTYDIR-GONE'), dd8);
check('remove keeps the copy the user edited', out.includes('==skept MINE-END'),
  section(out, 'skept'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ndesktop-defaults e2e: ${failures} FAILED`
                     : '\ndesktop-defaults e2e: PASS');
process.exit(failures ? 1 : 0);
