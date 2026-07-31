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
//   - sharing (todos/0288): TWO live processes with overlapping
//     lifetimes both keep their registry writes, in either exit order —
//     `k32demo reg-race`. The hive is one file shared by every win32
//     app, so a flush reload-merges instead of rewriting from the
//     snapshot it loaded at startup.
//
// Run: node tests/kernel/test_kernel32_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-k32-');

/* ---- session A: the selftest + the POSIX twin legs ---- */
function sessionA() {
  const script = [
    'echo posix-twin-line > /root/k32-posix.txt',
    // stderr via file + cat, the user32-e2e pattern (#318 fail-loud pins)
    'k32demo 2>/tmp/k32.err',
    'echo K32-EXIT=$?',
    'cat /tmp/k32.err',
    'echo ==out',
    'cat /root/k32-out.txt',
    'echo ==twin',
    'sh -c "echo spawned-by-kernel32; exit 3" > /root/k32-twin.txt',
    'echo TWIN-EXIT=$?',
    'cat /root/k32-twin.txt',
    '',
  ].join('\n');

  const a = driveBoot(script, { image });
  const out = a.stdout;

  const m = out.match(/K32: (\d+)\/(\d+) PASS/);
  check('k32demo prints K32: n/n PASS', m !== null && m[1] === m[2],
    (out.match(/FAIL [^\n]*/g) || []).join('; ') || out.slice(0, 400));
  check('k32demo exits 0', out.includes('K32-EXIT=0'));
  check('no failing checks', !/\nFAIL /.test(out));
  /* #318: the deliberate clear-failure stubs are LOUD now — the selftest's
   * CreateThread/LoadLibraryW probes must each leave a report */
  check('fail-loud: CreateThread refusal says so on stderr',
    /win32: unsupported CreateThread/.test(out),
    (out.match(/win32: unsupported [^\n]*/g) || []).join(' | '));
  check('fail-loud: LoadLibraryW refusal says so on stderr',
    /win32: unsupported LoadLibraryW/.test(out),
    (out.match(/win32: unsupported [^\n]*/g) || []).join(' | '));

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
    'k32demo reg-vol-check',
    'echo VOL-EXIT=$?',
    'grep -c K32Vol /root/.win32reg',
    'echo VOLGREP-EXIT=$?',
    'grep -c K32Demo /root/.win32reg',
    '',
  ].join('\n');

  const b = driveBoot(script, { image });
  const out = b.stdout;

  check('registry persists across boots (profile shim reads 2)',
    out.includes('reg-persist: layout=2') && out.includes('PERSIST-EXIT=0'),
    out.slice(0, 300));
  /* #319 gap #36: hostile value names ('|', newline, literal u0041/
   * u00e9 vs U+00E9) written by session A survive the hive-file
   * round-trip — this boot PARSES the escaped line format fresh */
  check('hostile registry names survive the hive round-trip',
    out.includes('reg-persist: hostile=ok'), out.slice(0, 300));
  /* #320: the volatile key session A created is GONE across the reload,
   * its persistent sibling survived (positive control), and the
   * KEY_READ-refused write never reached the file */
  check('volatile key vanished, sibling survived, refused write absent',
    out.includes('reg-vol: stay=1 gone=1 sam=1') && out.includes('VOL-EXIT=0'),
    (out.match(/reg-vol:[^\n]*/) || ['no reg-vol line'])[0]);
  /* belt + braces: not one hive-file LINE mentions the volatile key
   * (grep -c prints 0 and exits 1 on no match) */
  check('the hive file never mentions K32Vol',
    /\n0\nVOLGREP-EXIT=1\n/.test(out),
    (out.split('VOL-EXIT=0\n')[1] || '').slice(0, 80));
  check('the hive file is the real store ($HOME/.win32reg)',
    /\n[1-9]\d*\n/.test('\n' + (out.split('VOLGREP-EXIT=1\n')[1] || '')),
    out.slice(-200));
}

/* ---- session C: two live processes share the hive (todos/0288) ----
 *
 * `k32demo reg-race FIRST SECOND` spawns two agents that BOTH take their
 * hive snapshot and mutate it before EITHER flushes, then releases them in
 * the named order. Before 0288 the second flush rewrote the whole file from
 * its own start-of-process snapshot, so the first exiter's write vanished —
 * exactly what happened when a user had winmine and notepad open at once.
 *
 * Legs: both orders of a write/write pair, and both orders of a
 * delete/write pair (the delete must survive the peer's later flush, and
 * the peer must not resurrect a value it only ever read). The hive is wiped
 * between legs so a leftover value from the previous leg can't make the
 * next one pass vacuously. Session C runs last for that reason. */
function sessionC() {
  const leg = (a, b) => [
    'rm -f /root/.win32reg',
    'k32demo reg-set Keeper',
    `k32demo reg-race ${a} ${b}`,
    `echo RACE-EXIT=$?`,
  ];
  const script = [
    ...leg('A', 'B'),          // A flushes first, B last
    ...leg('B', 'A'),          // B flushes first, A last
    ...leg('-Keeper', 'W'),    // delete flushes first, write last
    ...leg('W', '-Keeper'),    // write flushes first, delete last
    '',
  ].join('\n');

  const c = driveBoot(script, { image });
  const out = c.stdout;

  const races = out.match(/reg-race\([^)]*\): [^\n]*/g) || [];
  check('all four two-process legs ran', races.length === 4, races.join(' | '));
  check('two live processes both keep their writes (A first)',
    races[0] === 'reg-race(A,B): A=1 B=1 -> OK', races[0]);
  check('two live processes both keep their writes (B first)',
    races[1] === 'reg-race(B,A): B=1 A=1 -> OK', races[1]);
  check('a delete survives a peer flush that follows it',
    races[2] === 'reg-race(-Keeper,W): Keeper=0 W=1 -> OK', races[2]);
  check('a peer never resurrects a value it only read',
    races[3] === 'reg-race(W,-Keeper): W=1 Keeper=0 -> OK', races[3]);
  check('every race exited 0',
    (out.match(/RACE-EXIT=0/g) || []).length === 4,
    (out.match(/RACE-EXIT=\d+/g) || []).join(','));
}

sessionA();
sessionB();
sessionC();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nkernel32 e2e: ${failures} FAILED` : '\nkernel32 e2e: PASS');
process.exit(failures ? 1 : 0);
