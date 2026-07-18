#!/usr/bin/env node
// 0072 acceptance, headless: file associations + the pickable default
// open app (os/openwith.h, one resolver shared by wm.c activate(),
// fileman and /bin/open). Covers:
//   - open(1), the terminal context: `--set` writes ~/.config/openwith
//     as a pure per-key user delta (CS3 cfgstore overlay — the /etc and
//     /usr/share layers keep serving every key the user didn't override),
//     extension associations and default.term resolve, the file path is
//     appended, missing files / bad usage fail loudly
//   - the desktop GUI context: double-clicking a .gb icon launches
//     /bin/sameboy (the baked default since 0072's flip) with that ROM
//     (a minimal synthesized cartridge — the header recipe from
//     vendor/gameboy's build_test_rom — so the SameBoy window STAYS up)
//   - fileman: Open on a .gb goes to sameboy, Open on an unassociated
//     extension goes to the default.gui program (notepad); the "With"
//     picker prefills the effective command, "Always for .txt" + OK
//     persists the pick and plain Open honors it afterwards
//   - .mgp (todos/0202): desktop dblclick AND fileman Open raise the mgp
//     VIEWER (the baked association), while the fileman row menu's Edit
//     and the desktop icon menu's EDIT open the deck TEXT in notepad
//     (openwith.h ow_editor — always default.gui, never the viewer)
//   - persistence: a second boot on the same image still resolves the
//     user associations
//
// Run: node tests/kernel/test_openwith_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, deskEntries, deskCell } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-openwith-');

function boot(script) {
  const r = driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* A minimal cartridge both GB cores initialize happily (the build_test_rom
 * recipe from vendor/gameboy/src/main.c): entry JP $0150, the Nintendo
 * logo, 'TEST' title, ROM-only type, and a valid header checksum — the
 * logo + checksum matter to SameBoy's embedded boot ROM. 0x150 bytes is
 * exactly the loaders' minimum; SameBoy pads the rest of the bank with
 * 0xFF, so execution NOPs to the pad and RST $38-loops forever, which is
 * all the test needs — a window that stays up. */
function minimalRom() {
  const rom = Buffer.alloc(0x150);
  rom[0x100] = 0x00; rom[0x101] = 0xC3; rom[0x102] = 0x50; rom[0x103] = 0x01;
  Buffer.from([
    0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B,
    0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
    0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E,
    0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
    0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC,
    0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
  ]).copy(rom, 0x104);
  Buffer.from('TEST').copy(rom, 0x134);
  let ck = 0;
  for (let i = 0x134; i <= 0x14C; i++) ck = (ck - rom[i] - 1) & 0xff;
  rom[0x14D] = ck;
  return rom;
}
const ROM_B64 = minimalRom().toString('base64');

/* Desktop grid geometry: the drive.js model (deskEntries/deskCell over
 * os/image.json — dirs first, Recycle Bin tail-pinned, column wrap at 11
 * rows on 1024x768; todos/0184/0185). game.gb's cell is derived from the
 * seeded set + the test's own drop. */
const GB = deskCell(deskEntries(['game.gb']), 'game.gb');
const DECK = deskCell(deskEntries(['game.gb', 'deck.mgp']), 'deck.mgp');

/* fileman row selection (the test_fileman_e2e idiom): click focuses the
 * listbox, HOME selects row 0, VK_DOWN steps — no row-height pixel math. */
const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const sel = (row) => ['wmctl click $SID 200 100', HOME,
                      ...Array(row).fill(DOWN)].join('\n');

/* fileman's picker/Open launches (activate() -> spawn, WNOHANG-reaped) run the
 * probe launcher ASYNCHRONOUSLY, so its "opened:" line lands in probe.out after
 * a beat with no WM/agent signal to key on. Replace the `sleep 2` guesses with a
 * bounded poll for the expected line count (todos/0154 — a condition poll, not a
 * fixed sync sleep; ~10s cap). */
const waitProbe = (n) =>
  `for i in $(seq 1 200); do [ "$(grep -c "^opened:" /root/probe.out 2>/dev/null)" -ge ${n} ] && break; sleep 0.05; done`;

const out = boot([
  // -- fixtures: probe launcher, a private dir for fileman rows, the ROM --
  "printf '#!/bin/sh\\necho opened:$1 >> /root/probe.out\\n' > /root/probe.sh",
  'mkdir /root/owtest',
  `echo '${ROM_B64}' | base64 -d > /root/owtest/game.gb`,
  'cp /root/owtest/game.gb /root/Desktop/game.gb',
  "printf 'plain text\\n' > /root/owtest/notes.txt",
  "printf 'readme\\n' > /root/owtest/readme.md",
  "printf 'x\\n' > /root/data.zzz",
  "printf 'y\\n' > /root/noext",

  // ---- open(1), the terminal context ----
  'open --set zzz /root/probe.sh',
  'open /root/data.zzz && echo open-zzz-ok',
  'echo ==probe1',
  'cat /root/probe.out',
  'echo ==cut',
  'open --set default.term /root/probe.sh',
  'open /root/noext',
  'echo ==probe2',
  'cat /root/probe.out',
  'echo ==cut',
  'echo ==conf1',
  'cat /root/.config/openwith',
  'echo ==cut',
  'open /root/missing.q || echo open-missing-fails',
  'open || echo open-usage-fails',

  // ---- CS3 (cfgstore.h): lower-layer keys reach a customized user ----
  // conf1 above is a pure user delta (zzz + default.term only), so the
  // /etc and /usr/share layers keep serving every other key per-key.
  // Pre-CS3 the user file's existence hid them whole-file: data.yyy would
  // fall to the user default.term (probe.sh -> an `opened:` line), never
  // /etc's probeB. (probe2 above is the override-wins twin: the user
  // default.term shadows the baked `vi` line in the merged store.)
  "printf '#!/bin/sh\\necho openedB:$1 >> /root/probe.out\\n' > /root/probeB.sh",
  "printf 'yyy\\t/root/probeB.sh\\n' > /etc/openwith",
  "printf 'w\\n' > /root/data.yyy",
  'open /root/data.yyy && echo open-yyy-ok',
  'echo ==ovl1',
  'cat /root/probe.out',
  'echo ==cut',

  // ---- fileman: .gb -> gameboy, picker, default.gui ----
  'fileman /root/owtest &',
  // Boot barrier: fileman serving the "Open" button label means its window is up,
  // the dir listing is loaded, and it is pumping the agent tree (todos/0154).
  'wmctl wait label Open 10000',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  sel(0),                                        // game.gb (no dirs in owtest)
  'wmctl click Open',
  'wmctl wait win SameBoy 8000',                 // .gb -> sameboy window up
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  sel(1),                                        // notes.txt
  'wmctl click With',
  'wmctl wait label "Always for .txt" 6000',     // the OpenWith picker is up
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  'echo ==prefill',
  'wmctl gettext EDIT:1',
  'echo ==cut',
  'wmctl settext EDIT:1 /root/probe.sh',
  'wmctl click "Always for .txt"',
  'wmctl click OK',
  'wmctl wait nolabel "Always for .txt" 6000',   // picker closed
  waitProbe(3),                                  // ...and the launch appended
  'echo ==probe3',
  'cat /root/probe.out',
  'echo ==cut',
  'echo ==conf2',
  'cat /root/.config/openwith',
  'echo ==cut',
  sel(1),                                        // notes.txt again, plain Open
  'wmctl click Open',
  waitProbe(4),
  'echo ==probe4',
  'cat /root/probe.out',
  'echo ==cut',
  sel(2),                                        // readme.md -> default.gui
  'wmctl click Open',
  'wmctl wait win "readme.md - Notepad" 12000',  // notepad loads freetype + opens
  'echo ==list3',
  'wmctl list',
  'echo ==cut',

  // ---- the desktop GUI context: dblclick the .gb icon ----
  // The desktop re-reads /root/Desktop on a coarse timer; there is no event for
  // "the game.gb icon is now present", so this stays an annotated timing tick
  // (0083 rule).
  'sleep 1',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  `wmctl dblclick $DSID ${GB.x + 42} ${GB.y + 32}`,
  'wmctl wait count SameBoy 2 8000',             // second sameboy window up
  'echo ==list4',
  'wmctl list',
  'echo ==cut',

  // ---- .mgp (todos/0202): dblclick/Open = the VIEWER, Edit = the EDITOR ----
  'cp /usr/share/mgp/tutorial/01-welcome.mgp /root/Desktop/deck.mgp',
  // Same coarse desk re-read tick as game.gb above (0083 rule, annotated).
  'sleep 1',
  `wmctl dblclick $DSID ${DECK.x + 42} ${DECK.y + 32}`,
  'wmctl wait win MagicPoint 15000 && echo MGP-DESK-OK', // desktop dblclick -> viewer
  'MSID=$(wmctl list | grep MagicPoint | sed "s/[^0-9].*//")',
  'wmctl key $MSID 0 113',                       // q quits the viewer
  'wmctl wait nowin MagicPoint 8000',
  // fileman at the Presentations folder: the decks live in SUBFOLDERS since
  // todos/0221 (MagicPoint Tutorial / POSIX on WebAssembly) — the folder
  // itself lists them, then Open (the dblclick path) on tutorial deck 01
  'wmctl settext EDIT:0 /root/Desktop/Presentations',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 "MagicPoint Tutorial" 8000 && echo SUBDIRS-OK',
  'wmctl settext EDIT:0 "/root/Desktop/Presentations/MagicPoint Tutorial"',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 01-welcome.mgp 8000',  // navigated (tutorial links)
  sel(0),                                        // 01-welcome.mgp sorts first
  'wmctl click Open',
  'wmctl wait win MagicPoint 15000 && echo MGP-FM-OK', // fileman Open -> viewer
  'MSID=$(wmctl list | grep MagicPoint | sed "s/[^0-9].*//")',
  'wmctl key $MSID 0 113',
  'wmctl wait nowin MagicPoint 8000',
  // the 0221 talk deck opens from its own subfolder too
  'wmctl settext EDIT:0 "/root/Desktop/Presentations/POSIX on WebAssembly"',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 posix-on-wasm.mgp 8000',
  sel(0),
  'wmctl click Open',
  'wmctl wait win MagicPoint 15000 && echo MGP-TALK-OK',
  'MSID=$(wmctl list | grep MagicPoint | sed "s/[^0-9].*//")',
  'wmctl key $MSID 0 113',
  'wmctl wait nowin MagicPoint 8000',
  // back to the tutorial folder so the Edit leg below rides row 0 = deck 01
  'wmctl settext EDIT:0 "/root/Desktop/Presentations/MagicPoint Tutorial"',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 01-welcome.mgp 8000',
  // the fileman row menu's Edit: the deck TEXT in notepad, not the viewer
  'wmctl click $SID 100 30 3',                   // right-click row 0
  'wmctl wait label Edit 8000',                  // row menu up (Edit row, 0202)
  'echo ==editmenu',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Edit',
  'wmctl wait win "01-welcome.mgp - Notepad" 15000 && echo EDIT-FM-OK',
  // the desktop icon menu's EDIT row (documents only, row 1 under OPEN)
  `wmctl click $DSID ${DECK.x + 42} ${DECK.y + 32} 3`,
  'wmctl wait win ctxmenu 8000',                 // icon menu up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 60 34',                    // EDIT (row 1 on a document, 0202)
  'wmctl wait win "deck.mgp - Notepad" 15000 && echo EDIT-DESK-OK',
  '',
].join('\n'));

const count = (sec, re) => sec.split('\n').filter(l => re.test(l)).length;

check('open --set + ext association runs the probe with the path appended',
  section(out, 'probe1').trim() === 'opened:/root/data.zzz' && out.includes('open-zzz-ok'),
  JSON.stringify(section(out, 'probe1')));
check('default.term is pickable and honored for extension-less files',
  section(out, 'probe2').trim().split('\n')[1] === 'opened:/root/noext',
  JSON.stringify(section(out, 'probe2')));
const conf1 = section(out, 'conf1');
check('~/.config/openwith is a pure user delta (CS3: no baked snapshot)',
  conf1.includes('zzz\t/root/probe.sh') &&
  conf1.includes('default.term\t/root/probe.sh') &&
  !/^gb\t/m.test(conf1) && !conf1.includes('default.gui'), conf1);
check('open on a missing file fails', out.includes('open-missing-fails'));
check('open without args prints usage and fails', out.includes('open-usage-fails'));
check('an /etc-layer key reaches through a customized user store (CS3 overlay)',
  section(out, 'ovl1').includes('openedB:/root/data.yyy') &&
  out.includes('open-yyy-ok'), JSON.stringify(section(out, 'ovl1')));

check('fileman Open on a .gb launches sameboy (SameBoy window up)',
  count(section(out, 'list2'), /\tSameBoy$/) === 1, section(out, 'list2'));
const tree1 = section(out, 'tree1');
check('With opens the picker (OpenWith window, Always + OK/Cancel)',
  /class=OpenWith/.test(tree1) && /text='Always for .txt'/.test(tree1) &&
  /text='OK'/.test(tree1) && /text='Cancel'/.test(tree1), tree1.slice(0, 400));
check('picker prefills the effective command (default.gui: notepad)',
  section(out, 'prefill').trim() === '/bin/notepad', section(out, 'prefill'));
check('picker OK opens the file with the picked command',
  section(out, 'probe3').trim().endsWith('opened:/root/owtest/notes.txt'),
  JSON.stringify(section(out, 'probe3')));
check('"Always" persisted the pick (txt association written)',
  section(out, 'conf2').includes('txt\t/root/probe.sh'), section(out, 'conf2'));
check('plain Open honors the persisted association',
  count(section(out, 'probe4'), /^opened:\/root\/owtest\/notes.txt$/) === 2,
  JSON.stringify(section(out, 'probe4')));
check('fileman Open on an unassociated extension opens the file in notepad',
  count(section(out, 'list3'), /\treadme\.md - Notepad$/) === 1,
  section(out, 'list3'));
check('...and no ERROR box (0111: the abs path is not a /-option)',
  count(section(out, 'list3'), /\tERROR$/) === 0, section(out, 'list3'));
check('desktop dblclick on the .gb icon launches sameboy (SameBoy +1)',
  count(section(out, 'list4'), /\tSameBoy$/) === 2, section(out, 'list4'));

// ---- .mgp: view vs edit (todos/0202) ----
check('desktop dblclick on a .mgp icon raises the mgp viewer',
  out.includes('MGP-DESK-OK'));
check('Presentations lists the tutorial subfolder (todos/0221 nesting)',
  out.includes('SUBDIRS-OK'));
check('fileman Open on a .mgp raises the mgp viewer',
  out.includes('MGP-FM-OK'));
check('the 0221 talk deck opens from its subfolder (fileman Open)',
  out.includes('MGP-TALK-OK'));
const editmenu = section(out, 'editmenu');
const editItem = editmenu.split('\n').find(l => l.includes("text='Edit'")) || '';
check('the fileman row menu has an enabled Edit item',
  editItem !== '' && !editItem.includes('grayed'), editmenu.slice(0, 400));
check('fileman Edit opens the deck TEXT in notepad',
  out.includes('EDIT-FM-OK'));
check('the desktop icon EDIT opens the deck TEXT in notepad',
  out.includes('EDIT-DESK-OK'));

// ---- persistence: a second boot on the same image ----
const out2 = boot([
  'open /root/data.zzz',
  'echo ==probe5',
  'cat /root/probe.out',
  'echo ==cut',
  '',
].join('\n'));
check('user associations survive a reboot',
  section(out2, 'probe5').trim().split('\n').pop() === 'opened:/root/data.zzz' &&
  count(section(out2, 'probe5'), /^opened:/) >= 4, JSON.stringify(section(out2, 'probe5')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
