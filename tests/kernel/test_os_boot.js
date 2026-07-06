#!/usr/bin/env node
// OS acceptance, headless (0004 + 0005): the reference OS boots under plain
// Node with busybox hush as pid 1 (/bin/sh), driven the way an agent or CI
// would drive it — pipes and exit codes.
//
//   - first boot seeds the image from os/image.json: protoshell, cc, tiny
//     cat/ls, and BUSYBOX HUSH built from vendor/busybox/bin.json by the
//     kernel's own compiler (no build step)
//   - the shell is real: pipelines (cross-process), command substitution
//     (spawn-self with serialized state, the NOMMU re-exec machinery on
//     __spawn), redirections, here-docs (bash-style temp file), control
//     flow, functions, exit-status propagation
//   - `cc hello.c && ./a.out` — the OS compiles and runs a program
//   - popen()/system() light up (the 0005 acceptance): a C program written
//     via here-doc, compiled in-OS, runs `popen("... | cat")` and
//     `system("... > file")`
//   - a second boot on the same image REUSES it; files persist
//
// Run: node tests/kernel/test_os_boot.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-boot-'));
const image = path.join(tmp, 'os.img');

function session(input, extraArgs) {
  // Not --quiet: the [boot] lines on stderr are themselves under test
  // (seeded vs reused); program stdout stays byte-clean either way (hush is
  // non-interactive under piped stdio — no prompts).
  const r = cp.spawnSync('node',
    [BOOT, '--image=' + image].concat(extraArgs || []),
    { input, encoding: 'utf8', timeout: 300000 });
  if (r.error) throw r.error;
  return r;
}

// ---- first boot: seed + the full shell gauntlet ----
let r = session([
  'ls /',                                  // seeded tree (tiny native ls)
  'echo A | cat | cat',                    // 3-stage cross-process pipeline
  'echo sub=$(echo inner $(echo deep))',   // nested command substitution
  'echo redir > /root/r.txt',
  'cat /root/r.txt',
  'for i in 1 2; do echo loop-$i; done',
  'f() { echo fn-$1; }; f arg',
  'case zap in z*) echo case-ok;; esac',
  'test 2 -gt 1 && echo test-ok',
  'false || echo or-ok',
  'false; echo status=$?',
  'cc hello.c && ./a.out',                 // compile + run, in-OS
  'exit 7',
  '',
].join('\n'), ['--fresh']);

check('exit N propagates through hush', r.status === 7, String(r.status) + ' ' + (r.stderr || '').slice(-300));
const lines = r.stdout.split('\n');
const expectStdout = [
  'bin', 'dev', 'etc', 'root', 'tmp',      // ls /
  'A',                                     // pipeline
  'sub=inner deep',                        // nested $( )
  'redir',                                 // > then cat
  'loop-1', 'loop-2',                      // for
  'fn-arg',                                // function
  'case-ok', 'test-ok', 'or-ok',           // case/test/||
  'status=1',                              // $?
  'hello, wasm world',                     // cc hello.c && ./a.out
];
for (let i = 0; i < expectStdout.length; i++) {
  check('stdout[' + i + '] = ' + JSON.stringify(expectStdout[i]),
    lines[i] === expectStdout[i], JSON.stringify(lines[i]));
}
check('first boot builds hush from vendor/busybox', r.stderr.includes('built vendor/busybox/bin.json'),
  r.stderr.slice(0, 300));

// ---- popen()/system(): the 0005 acceptance — heredoc -> cc -> run ----
r = session([
  "cat > po.c << 'CEOF'",
  '#include <stdio.h>',
  '#include <stdlib.h>',
  'int main(void) {',
  '    FILE *p = popen("echo from-popen | cat", "r");',
  '    char line[64];',
  '    if (p && fgets(line, sizeof line, p)) printf("read: %s", line);',
  '    printf("pclose: %d\\n", pclose(p));',
  '    printf("system: %d\\n", system("echo from-system > /tmp/sys.txt"));',
  '    FILE *f = fopen("/tmp/sys.txt", "r");',
  '    if (f && fgets(line, sizeof line, f)) printf("file: %s", line);',
  '    return 0;',
  '}',
  'CEOF',
  'cc po.c -o po && ./po',
  'exit',
  '',
].join('\n'));
check('popen/system session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
const po = r.stdout.split('\n');
const expectPo = ['read: from-popen', 'pclose: 0', 'system: 0', 'file: from-system'];
for (let i = 0; i < expectPo.length; i++) {
  check('popen[' + i + '] = ' + JSON.stringify(expectPo[i]), po[i] === expectPo[i], JSON.stringify(po[i]));
}

// ---- second boot, same image: persistence + no re-seed ----
r = session('ls\nexit\n');
check('second boot exits clean', r.status === 0, String(r.status));
check('no re-seed on second boot', !r.stderr.includes('seeding image'), r.stderr.slice(0, 200));
const names = r.stdout.split('\n');
check('a.out persisted across reboot', names.includes('a.out'), JSON.stringify(names.slice(0, 5)));
check('po persisted across reboot', names.includes('po'), JSON.stringify(names.slice(0, 6)));

// ---- failure modes leave the OS alive ----
r = session('cc nosuch.c\necho alive\nexit\n');
check('OS survives a failed cc', r.stdout.split('\n')[0] === 'alive', JSON.stringify(r.stdout.split('\n')[0]));
check('cc error reaches stderr', /nosuch\.c/.test(r.stderr), r.stderr.slice(-300));

r = session('definitely-not-a-command\nexit\n');
check('unknown command reported', /can't execute|not found/.test(r.stderr), r.stderr.slice(-200));
check('unknown command is 127 via $?', r.status === 127, String(r.status));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nos boot (headless, hush): PASS' : `\nos boot (headless, hush): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
