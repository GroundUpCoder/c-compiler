#!/usr/bin/env node
// #417 + #418 + #583 acceptance, headless: NetSurf, the demo bundle, the two GB
// emulators, Calc and Paint live OUT of the base image as gucman packages. Each app must
// install from a MINIMAL image (boot.js --packages=none) that provably does
// not contain it, and then LAUNCH AND RUN — an installed package that does
// not start is a fail.
//
//   - the minimal image really is minimal: none of the moved binaries, menu
//     entries, openwith keys, or /usr/share/netsurf exist
//   - `gucman install netsurf` -> the RESOURCE CLOSURE holds from the
//     package tree (#417's hard part): a bare `netsurf` opens the packaged
//     welcome page (about:welcome -> resource:welcome.html, resolving
//     through the /opt/netsurf/res respath — Messages, css, welcome.html
//     and the about:logo png all come from the package), and a real
//     file:// page parses, titles its window, and renders
//   - `gucman install demos` -> winbox opens its window, and ctldemo
//     builds its controls (agent label visible — the .res SIDECAR resolved
//     through /usr/local/bin/ctldemo -> /opt/demos/ctldemo + ctldemo.res;
//     a missing sidecar is a blank app, which `wait label` catches)
//   - `gucman install gameboy` / `install sameboy` -> each emulator LOADS A
//     REAL ROM (the minimal valid cartridge from vendor/gameboy's
//     build_test_rom recipe — logo + header checksum, which SameBoy's boot
//     ROM actually verifies) and keeps its window up
//
// NB the netsurf legs here drive file:// and resource: urls only (like the
// whole netsurf suite — #369); the http fetcher is NOT exercised by this
// test. The installed binary is byte-identical to the folded one (one
// compile pipeline), so test_netsurf_http_e2e's fat-image coverage carries.
//
// Run: node tests/kernel/test_gucman_apps_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* A minimal cartridge both GB cores initialize happily (the build_test_rom
 * recipe from vendor/gameboy/src/main.c, the test_openwith_e2e idiom):
 * entry JP $0150, the Nintendo logo, 'TEST' title, ROM-only type, valid
 * header checksum — logo + checksum matter to SameBoy's embedded boot ROM. */
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

async function main() {
  const repo = ensurePackages(['netsurf', 'demos', 'gameboy', 'sameboy', 'calc', 'paint']);
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-apps-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const port = await startServer(repo.dir);
  console.log(`[gucman-apps] repo :${port}`);

  const script = [
    'echo ==minimal',
    'for b in netsurf winbox gpubox gdidemo ctldemo fontramp gdiplusdemo k32demo gameboy sameboy calc paint; do test ! -e /bin/$b || echo BAKED-$b; done',
    'echo BIN-SWEEP-DONE',
    'test ! -e /usr/share/netsurf && echo NO-NETSURF-RES',
    'test ! -e /usr/share/menu/Accessories/netsurf && echo NO-NETSURF-MENU',
    'test ! -e /usr/share/menu/Demos/winbox && echo NO-WINBOX-MENU',
    'test ! -e /usr/share/menu/Games/sameboy && echo NO-SAMEBOY-MENU',
    'grep -q "^html" /usr/share/openwith || echo NO-HTML-KEY',
    'grep -q "^gb" /usr/share/openwith || echo NO-GB-KEY',
    'grep -q "^bmp" /usr/share/openwith || echo NO-BMP-KEY',
    'echo ==install',
    'mkdir -p /etc/gucman',
    'mkdir -p /var/lib/gucman && echo on > /var/lib/gucman/desktop_shortcuts',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install netsurf; echo NS-RC=$?',
    'gucman install demos; echo DM-RC=$?',
    'gucman install gameboy; echo GB-RC=$?',
    'gucman install sameboy; echo SB-RC=$?',
    'gucman install calc; echo CALC-RC=$?',
    'gucman install paint; echo PAINT-RC=$?',
    'readlink /usr/local/bin/netsurf',
    'readlink /etc/menu/Accessories/netsurf && echo NS-MENU-OK',
    'grep "^html" /etc/openwith',
    'grep "^gb" /etc/openwith',
    'grep "^bmp" /etc/openwith',
    'readlink /etc/menu/Accessories/calc && echo CALC-MENU-OK',
    'readlink /etc/menu/Accessories/paint && echo PAINT-MENU-OK',
    'readlink /root/Desktop/calc && echo CALC-DESK-OK',
    'readlink /root/Desktop/paint && echo PAINT-DESK-OK',
    'calc &',
    'wmctl wait win Calculator 30000 || { echo CALC-WAIT-FAIL; wmctl list; exit 1; }',
    'CSID=$(wmctl list | grep "\tCalculator$" | sed "s/[^0-9].*//")',
    'wmctl close $CSID',
    'wmctl wait nowin Calculator 8000',
    'echo CALC-OK',
    'paint &',
    'wmctl wait win "untitled - Paint" 30000 || { echo PAINT-WAIT-FAIL; wmctl list; exit 1; }',
    'PTSID=$(wmctl list | grep "\tuntitled - Paint$" | sed "s/[^0-9].*//")',
    'wmctl close $PTSID',
    'wmctl wait nowin "untitled - Paint" 8000',
    'echo PAINT-OK',
    'echo ==netsurf',
    // resource closure: about:welcome -> resource:welcome.html out of
    // /opt/netsurf/res (Messages/css/png ride the same respath)
    'netsurf &',
    'wmctl wait win "Welcome to gucOS" 30000',
    'WSID=$(wmctl list | grep "\tWelcome to gucOS$" | sed "s/[^0-9].*//")',
    'wmctl close $WSID',
    'wmctl wait nowin "Welcome to gucOS" 8000',
    'echo WELCOME-OK',
    // a real page: parse -> title -> render -> shot
    'printf \'<html><head><title>PkgPage</title></head><body style="margin:0;background:#ff0000"><h1>packaged</h1></body></html>\' > /root/t.html',
    'netsurf /root/t.html &',
    'wmctl wait win PkgPage 30000',
    'PSID=$(wmctl list | grep "\tPkgPage$" | sed "s/[^0-9].*//")',
    'wmctl shot $PSID /root/ns.png && [ -s /root/ns.png ] && echo PAGE-SHOT-OK',
    'wmctl close $PSID',
    'wmctl wait nowin PkgPage 8000',
    'echo ==demos',
    'winbox &',
    'wmctl wait win winbox 30000',
    'WBSID=$(wmctl list | grep "\twinbox$" | sed "s/[^0-9].*//")',
    'wmctl close $WBSID',
    'wmctl wait nowin winbox 8000',
    'echo WINBOX-OK',
    'ctldemo &',
    'wmctl wait win "Control Demo" 30000',
    'wmctl wait label Greet 10000',
    'CDSID=$(wmctl list | grep "\tControl Demo$" | sed "s/[^0-9].*//")',
    'wmctl close $CDSID',
    'wmctl wait nowin "Control Demo" 8000',
    'echo CTLDEMO-OK',
    'echo ==emulators',
    `echo '${ROM_B64}' | base64 -d > /root/t.gb`,
    'gameboy /root/t.gb &',
    'wmctl wait win Peanut-GB 30000',
    'PGSID=$(wmctl list | grep "\tPeanut-GB$" | sed "s/[^0-9].*//")',
    'wmctl close $PGSID',
    'wmctl wait nowin Peanut-GB 8000',
    'echo GAMEBOY-OK',
    'sameboy /root/t.gb &',
    'wmctl wait win SameBoy 30000',
    'SBSID=$(wmctl list | grep "\tSameBoy$" | sed "s/[^0-9].*//")',
    'wmctl close $SBSID',
    'wmctl wait nowin SameBoy 8000',
    'echo SAMEBOY-OK',
    '',
  ].join('\n');

  const r = driveBoot(script, { image, args: ['--packages=none'],
                                timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout;

  const min = section(out, 'minimal');
  check('minimal image carries NONE of the moved binaries',
    min.includes('BIN-SWEEP-DONE') && !/BAKED-/.test(min), min);
  check('no baked /usr/share/netsurf', out.includes('NO-NETSURF-RES'));
  check('no baked menu entries (netsurf/winbox/sameboy)',
    out.includes('NO-NETSURF-MENU') && out.includes('NO-WINBOX-MENU') &&
    out.includes('NO-SAMEBOY-MENU'));
  check('no baked html/gb/bmp openwith keys',
    out.includes('NO-HTML-KEY') && out.includes('NO-GB-KEY') && out.includes('NO-BMP-KEY'));

  check('all six packages install (RC=0)',
    out.includes('NS-RC=0') && out.includes('DM-RC=0') &&
    out.includes('GB-RC=0') && out.includes('SB-RC=0') &&
    out.includes('CALC-RC=0') && out.includes('PAINT-RC=0'), section(out, 'install'));
  check('install plants the netsurf bin symlink',
    out.includes('/opt/netsurf/netsurf'));
  check('install plants the netsurf menu entry', out.includes('NS-MENU-OK'));
  check('install plants html + gb + bmp openwith keys',
    /html\t.*netsurf/.test(out) && /gb\t.*sameboy/.test(out) &&
    /bmp\t.*paint/.test(out));
  check('calc/paint install plants menu + Desktop entries',
    out.includes('CALC-MENU-OK') && out.includes('PAINT-MENU-OK') &&
    out.includes('CALC-DESK-OK') && out.includes('PAINT-DESK-OK'));
  check('packaged calc launches', out.includes('CALC-OK'));
  check('packaged paint launches', out.includes('PAINT-OK'));

  check('bare netsurf opens the packaged welcome page (resource closure)',
    out.includes('WELCOME-OK'));
  check('a real file:// page parses, titles and shots', out.includes('PAGE-SHOT-OK'));
  check('winbox launches from the demos bundle', out.includes('WINBOX-OK'));
  check('ctldemo launches with live controls (.res sidecar resolved)',
    out.includes('CTLDEMO-OK'));
  check('gameboy loads a real ROM', out.includes('GAMEBOY-OK'));
  check('sameboy loads a real ROM (boot-ROM logo + checksum verified)',
    out.includes('SAMEBOY-OK'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman apps e2e: ${failures} FAILED`
                       : '\ngucman apps e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
