#!/usr/bin/env node
// Lane B2 (win32 source-lib design §4/§8) acceptance: win32 apps compile
// IN-OS with the real cc. `#include <windows.h>` pulls the whole veneer +
// freetype through the header's __require_source block (§4.1/§4.2), the
// require names resolve at the standard srclib install tiers, and every
// pulled TU compiles under its PHYSICAL payload path (the pp.realpath
// hook, amending the design's §1.5 premise) so gdi32.c's "../fontcore.h"
// and the freetype shims' "../src/..." — lexically hopeless through the
// symlink farms — resolve inside the payload's real tree.
//
//   - FAT image: `cc hellowin.c` (no -I, no explicit TU list) builds a
//     window + labelled BUTTON app; it spawns, `wmctl tree` shows the
//     button, `wmctl click` presses it, the click retitles the window —
//     the window and button are REAL, end to end
//   - the documented wWinMain path (§4.2): `cc -DUNICODE wapp.c
//     /usr/src/win32/wwinmain.c` — the CRT shim as an explicit TU beside
//     the pulled veneer (path-identity dedup keeps it single)
//   - the engine-only SUBSET (§4.1 menucore.h + the WIN32_NO_REQUIRE_SOURCES
//     guard): `cc -I/usr/src/win32` of a menucore.h app pulls exactly
//     menucore + gdi32 + freetype — a user32 symbol is a LOUD link error,
//     proving the full-veneer block stayed suppressed
//   - MINIMAL image: cc of a windows.h app fails CLEAN (no srclib tiers),
//     `gucman install win32` plants /usr/local/{include,src}, and the
//     same compile + spawn works through the installed (writable-tier)
//     symlink farms
//
// Run: node tests/kernel/test_cc_win32_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The acceptance app: a window titled "hellowin" holding one labelled
// BUTTON; the click retitles the window (SetWindowText -> the kernel
// surface title -> `wmctl wait win` sees it) and prints a marker.
const HELLOWIN_C = [
  '#include <windows.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  '#define IDB_PRESS 100',
  'static LRESULT CALLBACK HelloProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {',
  '    switch (msg) {',
  '    case WM_COMMAND:',
  '        if (LOWORD(wParam) == IDB_PRESS) {',
  '            SetWindowText(hwnd, "hellowin-clicked");',
  '            printf("hellowin: pressed\\n");',
  '            fflush(stdout);',
  '            return 0;',
  '        }',
  '        break;',
  '    case WM_DESTROY:',
  '        PostQuitMessage(0);',
  '        return 0;',
  '    }',
  '    return DefWindowProc(hwnd, msg, wParam, lParam);',
  '}',
  'int main(void) {',
  '    WNDCLASS wc;',
  '    memset(&wc, 0, sizeof wc);',
  '    wc.lpfnWndProc = HelloProc;',
  '    wc.lpszClassName = "hellowin";',
  '    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);',
  '    if (!RegisterClass(&wc)) return 3;',
  '    HWND hwnd = CreateWindowEx(0, "hellowin", "hellowin", WS_OVERLAPPED | WS_VISIBLE,',
  '                               CW_USEDEFAULT, CW_USEDEFAULT, 320, 200, NULL, NULL, NULL, NULL);',
  '    if (!hwnd) return 3;',
  '    CreateWindowEx(0, "BUTTON", "Press Me", WS_CHILD | WS_VISIBLE,',
  '                   40, 60, 120, 28, hwnd, (HMENU)IDB_PRESS, NULL, NULL);',
  '    MSG msg;',
  '    while (GetMessage(&msg, NULL, 0, 0)) {',
  '        TranslateMessage(&msg);',
  '        DispatchMessage(&msg);',
  '    }',
  '    return 0;',
  '}',
];

// The wWinMain flavor (§4.2's documented command line): UNICODE build,
// entry via the /usr/src/win32/wwinmain.c CRT shim as an explicit TU.
const WAPP_C = [
  '#include <windows.h>',
  '#include <string.h>',
  'static LRESULT CALLBACK WProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {',
  '    if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }',
  '    return DefWindowProc(hwnd, msg, wParam, lParam);',
  '}',
  'int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR cmdLine, int show) {',
  '    WNDCLASS wc;',
  '    memset(&wc, 0, sizeof wc);',
  '    wc.lpfnWndProc = WProc;',
  '    wc.lpszClassName = TEXT("wwinapp");',
  '    if (!RegisterClass(&wc)) return 3;',
  '    HWND hwnd = CreateWindowEx(0, TEXT("wwinapp"), TEXT("wwinapp"), WS_OVERLAPPED | WS_VISIBLE,',
  '                               CW_USEDEFAULT, CW_USEDEFAULT, 240, 160, NULL, NULL, NULL, NULL);',
  '    if (!hwnd) return 3;',
  '    MSG msg;',
  '    while (GetMessage(&msg, NULL, 0, 0)) {',
  '        TranslateMessage(&msg);',
  '        DispatchMessage(&msg);',
  '    }',
  '    return 0;',
  '}',
];

const writeApp = (path, lines) => [
  `cat > ${path} << 'EOF'`, ...lines, 'EOF',
];

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-ccwin32-');
  const scriptA = [
    ...writeApp('/root/hellowin.c', HELLOWIN_C),
    ...writeApp('/root/wapp.c', WAPP_C),
    'echo ==cc',
    'cd /root && cc hellowin.c -o hellowin.out',
    'echo ccrc=$?',
    'echo ==run',
    './hellowin.out &',
    'HPID=$!',
    'wmctl wait win hellowin',
    // the surface exists at CreateWindowEx, but the agent socket binds from
    // the GetMessage idle loop — wait on the LABEL (agent-tree wait) before
    // dumping the tree, or a fast drive races an empty /run/win32
    'wmctl wait label "Press Me"',
    'echo ==tree',
    'wmctl tree',
    'echo ==click',
    'wmctl click "Press Me"',
    'wmctl wait win hellowin-clicked',
    'echo TITLE-CHANGED',
    'kill $HPID',
    'wmctl wait nowin hellowin-clicked',
    'echo ==wwinmain',
    'cc -DUNICODE wapp.c /usr/src/win32/wwinmain.c -o wapp.out',
    'echo wccrc=$?',
    './wapp.out &',
    'WPID=$!',
    'wmctl wait win wwinapp',
    'echo WAPP-UP',
    'kill $WPID',
    'wmctl wait nowin wwinapp',
    'echo ==engine',
    // engine-only subset: menucore.h defines WIN32_NO_REQUIRE_SOURCES, so
    // only its own block (menucore.c + gdi32.c -> freetype) fires
    "cat > /root/engine.c << 'EOF'",
    '#include <menucore.h>',
    'int main(void) { void (*f)(int) = mc_typeahead; return f ? 0 : 1; }',
    'EOF',
    'cc -I/usr/src/win32 engine.c -o engine.out && ./engine.out && echo ENGINE-OK',
    "cat > /root/engine2.c << 'EOF'",
    '#include <menucore.h>',
    'int main(void) { return MessageBoxA(0, "x", "y", 0); }',
    'EOF',
    'cc -I/usr/src/win32 engine2.c -o engine2.out 2>&1',
    'echo e2rc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 420000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const cc = section(aout, 'cc');
  check('fat: cc hellowin.c compiles (require block pulls the veneer)',
    cc.includes('ccrc=0'), cc);

  // NB the tree dump's own per-app header is '== pid N', which section()
  // reads as a terminator — assert the dump lines on the full output
  // (class=/text= line shapes are unique to `wmctl tree`).
  check('fat: agent tree shows the top-level window',
    /class=hellowin .*text='hellowin'/.test(aout), aout.slice(-600));
  check('fat: agent tree shows the labelled BUTTON',
    /class=BUTTON id=100 .*text='Press Me'/.test(aout), aout.slice(-600));

  const click = section(aout, 'click');
  check('fat: wmctl click presses the button (stdout marker)',
    aout.includes('hellowin: pressed'), click);
  check('fat: the click retitles the window (SetWindowText -> surface title)',
    click.includes('TITLE-CHANGED'), click);

  const wmain = section(aout, 'wwinmain');
  check('fat: cc -DUNICODE wapp.c /usr/src/win32/wwinmain.c compiles',
    wmain.includes('wccrc=0'), wmain);
  check('fat: the wWinMain app opens its window', wmain.includes('WAPP-UP'), wmain);

  const engine = section(aout, 'engine');
  check('fat: engine-only subset compiles and runs (menucore.h block)',
    engine.includes('ENGINE-OK'), engine);
  check('fat: user32 stays OUT of the subset (loud link error)',
    /Undefined symbol/.test(engine) && /e2rc=[^0]/.test(engine), engine);

  /* ---- session B: the minimal image + gucman install win32 ---- */
  const repo = ensurePackages(['win32']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-ccwin32-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const goodPort = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/hellowin.c', HELLOWIN_C),
    'echo ==nolib',
    'cd /root && cc hellowin.c 2>&1',
    'echo norc=$?',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'gucman install win32; echo IRC=$?',
    'echo ==cc2',
    'cc hellowin.c -o hellowin.out',
    'echo ccrc=$?',
    './hellowin.out &',
    'HPID=$!',
    'wmctl wait win hellowin',
    'echo MIN-WIN-UP',
    'wmctl click "Press Me"',
    'wmctl wait win hellowin-clicked',
    'echo MIN-TITLE-CHANGED',
    'kill $HPID',
    'wmctl wait nowin hellowin-clicked',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 420000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const nolib = section(bout, 'nolib');
  check('minimal: cc fails CLEAN without the srclib package',
    /norc=[^0]/.test(nolib) && /windows\.h/.test(nolib), nolib);

  const inst = section(bout, 'install');
  check('minimal: gucman install win32 succeeds', inst.includes('IRC=0'), inst);

  const cc2 = section(bout, 'cc2');
  check('minimal: cc compiles through /usr/local/{include,src}',
    cc2.includes('ccrc=0'), cc2);
  check('minimal: the app opens its window', cc2.includes('MIN-WIN-UP'), cc2);
  check('minimal: the button clicks (installed-tier physical paths)',
    cc2.includes('MIN-TITLE-CHANGED'), cc2);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-win32 e2e: ${failures} FAILED` : '\ncc-win32 e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
