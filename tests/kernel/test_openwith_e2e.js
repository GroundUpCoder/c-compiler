#!/usr/bin/env node
// 0072 acceptance, headless: file associations + the pickable default
// open app (os/openwith.h, one resolver shared by wm.c activate(),
// fileman and /bin/open). Covers:
//   - open(1), the terminal context: `--set` writes ~/.config/openwith
//     (effective table carried forward from the baked /usr/share seed),
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
//   - persistence: a second boot on the same image still resolves the
//     user associations
//
// Run: node tests/kernel/test_openwith_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-openwith-'));
const image = path.join(tmp, 'os.img');

function boot(script) {
  const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
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

/* Desktop grid geometry (wm.c): column-major, 16px margin, 84x64 cells,
 * 11 rows on the 1024x768 headless screen; column-0 icon centers sit at
 * x=58, y = 16 + row*64 + 32. Seeded /root/Desktop + the test's game.gb,
 * sorted (the 0093 Recycle Bin pins to the grid TAIL, so it never shifts
 * these cells). */
const DESK = ['doom', 'drmario', 'game.gb', 'gameboy', 'mario', 'pokemon',
              'quake', 'term'];
const deskY = (name) => 16 + DESK.indexOf(name) * 64 + 32;

/* fileman row selection (the test_fileman_e2e idiom): click focuses the
 * listbox, HOME selects row 0, VK_DOWN steps — no row-height pixel math. */
const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const sel = (row) => ['wmctl click $SID 200 100', HOME,
                      ...Array(row).fill(DOWN)].join('\n');

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

  // ---- fileman: .gb -> gameboy, picker, default.gui ----
  'fileman /root/owtest &',
  'sleep 5',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  sel(0),                                        // game.gb (no dirs in owtest)
  'wmctl click Open',
  'sleep 4',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  sel(1),                                        // notes.txt
  'wmctl click With',
  'sleep 1',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  'echo ==prefill',
  'wmctl gettext EDIT:1',
  'echo ==cut',
  'wmctl settext EDIT:1 /root/probe.sh',
  'wmctl click "Always for .txt"',
  'wmctl click OK',
  'sleep 2',
  'echo ==probe3',
  'cat /root/probe.out',
  'echo ==cut',
  'echo ==conf2',
  'cat /root/.config/openwith',
  'echo ==cut',
  sel(1),                                        // notes.txt again, plain Open
  'wmctl click Open',
  'sleep 2',
  'echo ==probe4',
  'cat /root/probe.out',
  'echo ==cut',
  sel(2),                                        // readme.md -> default.gui
  'wmctl click Open',
  'sleep 6',                                     // notepad loads freetype
  'echo ==list3',
  'wmctl list',
  'echo ==cut',

  // ---- the desktop GUI context: dblclick the .gb icon ----
  'sleep 1',                                     // desk re-read tick is coarse
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  `wmctl dblclick $DSID 58 ${deskY('game.gb')}`,
  'sleep 4',
  'echo ==list4',
  'wmctl list',
  'echo ==cut',
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
check('~/.config/openwith carries the baked defaults forward',
  conf1.includes('gb\t/bin/sameboy') && conf1.includes('gbc\t/bin/sameboy') &&
  conf1.includes('default.gui\t/bin/notepad'), conf1);
check('...plus the user associations', conf1.includes('zzz\t/root/probe.sh') &&
  conf1.includes('default.term\t/root/probe.sh'), conf1);
check('open on a missing file fails', out.includes('open-missing-fails'));
check('open without args prints usage and fails', out.includes('open-usage-fails'));

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
check('fileman Open on an unassociated extension opens the GUI default (notepad)',
  count(section(out, 'list3'), /Notepad$/) === 1, section(out, 'list3'));
check('desktop dblclick on the .gb icon launches sameboy (SameBoy +1)',
  count(section(out, 'list4'), /\tSameBoy$/) === 2, section(out, 'list4'));

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
