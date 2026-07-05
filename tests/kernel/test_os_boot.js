#!/usr/bin/env node
// 0004 acceptance, headless half: the reference OS boots under plain Node
// with the tty on stdio (OS.md "agent-friendly by construction"), driven
// exactly the way an agent or CI would drive it — pipes and exit codes:
//
//   - first boot seeds the image from os/image.json (protoshell + cc
//     compiled INTO the image by the kernel's own compile hook)
//   - `ls /` over a pipe prints the seeded tree
//   - `cc hello.c && ./a.out` — the OS compiles and runs a program
//   - `exit N` propagates as boot.js's exit code
//   - a second boot on the same image file REUSES it (no re-seed) and sees
//     files created in the first session — persistence across "reboots"
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
  // (seeded vs reused), and program stdout stays clean either way.
  const r = cp.spawnSync('node',
    [BOOT, '--image=' + image].concat(extraArgs || []),
    { input, encoding: 'utf8', timeout: 120000 });
  if (r.error) throw r.error;
  return r;
}

// ---- first boot: seed + the canonical session ----
let r = session([
  'ls /',
  'pwd',
  'echo hi from the protoshell',
  'cc hello.c && ./a.out',
  'ls',
  'cat /etc/.image-version',
  'exit 7',
  '',
].join('\n'), ['--fresh']);

check('exit N propagates', r.status === 7, String(r.status));
const lines = r.stdout.split('\n');
const expectStdout = [
  'bin', 'dev', 'etc', 'root',        // ls /
  '/root',                            // pwd
  'hi from the protoshell',           // echo
  'hello, wasm world',                // cc hello.c && ./a.out
  'a.out', 'hello.c',                 // ls (after cc)
  '1',                                // /etc/.image-version
];
for (let i = 0; i < expectStdout.length; i++) {
  check('stdout[' + i + '] = ' + JSON.stringify(expectStdout[i]),
    lines[i] === expectStdout[i], JSON.stringify(lines[i]));
}
check('first boot seeds the image', r.stderr.includes('(compiled protoshell.c)'), r.stderr.slice(0, 200));
check('prompts go to stderr, not stdout', !r.stdout.includes('# '));

// ---- second boot, same image: persistence + no re-seed ----
r = session('ls\nexit\n');
check('second boot exits clean', r.status === 0, String(r.status) + ' ' + r.stderr.slice(0, 300));
check('no re-seed on second boot', !r.stderr.includes('seeding image'), r.stderr.slice(0, 200));
check('a.out persisted across reboot', r.stdout.split('\n')[0] === 'a.out', JSON.stringify(r.stdout.split('\n')[0]));

// ---- compile errors surface as cc failure, not a wedged system ----
r = session('cc nosuch.c\necho alive\nexit\n');
check('OS survives a failed cc (next command runs)', r.stdout.split('\n')[0] === 'alive',
  JSON.stringify(r.stdout.split('\n')[0]));
check('cc error reaches stderr', /nosuch\.c/.test(r.stderr), r.stderr.slice(-300));
check('bare exit propagates $? = 0 after echo', r.status === 0, String(r.status));

// ---- unknown command: 127, flowing into $? ----
r = session('definitely-not-a-command\nexit\n');
check('unknown command reported', /command not found/.test(r.stderr), r.stderr.slice(-200));
check('unknown command is 127 via $?', r.status === 127, String(r.status));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nos boot (headless): PASS' : `\nos boot (headless): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
