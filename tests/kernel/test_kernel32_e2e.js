#!/usr/bin/env node
// 0059 acceptance, headless: the win32 kernel32/advapi32/wide-CRT veneer
// (os/win32/, design todos/WIN32.md) over the real OS through os/boot.js.
//   - `k32demo` self-checks the whole surface in-OS (files, seek/size,
//     dirs, wildcard find, file mapping, Global/Local/Heap/Virtual,
//     UTF-16<->UTF-8, wsprintf/_stscanf/strsafe, tick/QPC/date-format,
//     registry round-trip incl. ERROR_MORE_DATA, CreateProcess ->
//     posix_spawn with a redirected std handle, clear-failure stubs) and
//     must print K32: n/n PASS with exit 0.
//   - POSIX-twin identity: the file kernel32 wrote reads back byte-equal
//     through hush's cat, the file hush wrote reads back through
//     CreateFileW (the demo echoes it), and the hush redirect twin of the
//     CreateProcess leg produces the same bytes + exit code.
//   - persistence: a SECOND boot of the same image still sees the
//     registry hive ($HOME/.win32reg) — `k32demo reg-persist`.
//
// Run: node tests/kernel/test_kernel32_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-k32-'));
const image = path.join(tmp, 'os.img');

/* ---- session A: the selftest + the POSIX twin legs ---- */
function sessionA() {
  const script = [
    'echo posix-twin-line > /root/k32-posix.txt',
    'k32demo',
    'echo K32-EXIT=$?',
    'echo ==out',
    'cat /root/k32-out.txt',
    'echo ==twin',
    'sh -c "echo spawned-by-kernel32; exit 3" > /root/k32-twin.txt',
    'echo TWIN-EXIT=$?',
    'cat /root/k32-twin.txt',
    '',
  ].join('\n');

  const a = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000 });
  if (a.error) throw a.error;
  const out = a.stdout;

  const m = out.match(/K32: (\d+)\/(\d+) PASS/);
  check('k32demo prints K32: n/n PASS', m !== null && m[1] === m[2],
    (out.match(/FAIL [^\n]*/g) || []).join('; ') || out.slice(0, 400));
  check('k32demo exits 0', out.includes('K32-EXIT=0'));
  check('no failing checks', !/\nFAIL /.test(out));

  /* twin leg 1: hush reads back what WriteFile wrote, byte-exact */
  const cut = out.split('==out\n')[1] || '';
  check('cat sees exactly what WriteFile wrote',
    cut.startsWith('kernel32 wrote this line\nsecond line\n'),
    JSON.stringify(cut.slice(0, 60)));

  /* twin leg 2: CreateFileW read back what hush echoed */
  check('CreateFileW reads back what hush wrote',
    out.includes('posix-says: posix-twin-line'));

  /* twin leg 3: the hush redirect twin of the CreateProcess leg — same
   * bytes, same exit code (the demo asserted its own side already) */
  const twin = out.split('==twin\n')[1] || '';
  check('hush twin: same exit code', twin.includes('TWIN-EXIT=3'), twin);
  check('hush twin: same bytes', twin.includes('spawned-by-kernel32'), twin);

  /* the module/cmdline identity comes from the synthetic /proc */
  check('GetModuleFileName resolves via /proc', out.includes('module: /'));
}

/* ---- session B: a fresh boot still sees the registry hive ---- */
function sessionB() {
  const script = [
    'k32demo reg-persist',
    'echo PERSIST-EXIT=$?',
    'grep -c K32Demo /root/.win32reg',
    '',
  ].join('\n');

  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000 });
  if (b.error) throw b.error;
  const out = b.stdout;

  check('registry persists across boots (profile shim reads 2)',
    out.includes('reg-persist: layout=2') && out.includes('PERSIST-EXIT=0'),
    out.slice(0, 300));
  check('the hive file is the real store ($HOME/.win32reg)',
    /\n[1-9]\d*\n/.test('\n' + (out.split('PERSIST-EXIT=0\n')[1] || '')),
    out.slice(-200));
}

sessionA();
sessionB();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nkernel32 e2e: ${failures} FAILED` : '\nkernel32 e2e: PASS');
process.exit(failures ? 1 : 0);
