#!/usr/bin/env node
// open(O_CREAT) through a dangling symlink creates the TARGET (todos/0375).
//
// The bug: BlockFS's create branch inserted a dirent for the LEXICAL final
// name without re-checking that a (symlink) dirent of that name already
// existed — `echo x > dangling-link` appended a SECOND dirent under the
// link's own name (on-disk directory corruption; unlink then removed the
// new file and resurrected the symlink). POSIX: open(O_CREAT) follows the
// final symlink and creates its target. mkdir/mknod/link had the sibling
// defect (full-follow EEXIST checks: a dangling link answered "doesn't
// exist"), fixed to refuse EEXIST per POSIX.
//
// This drives the BROKERED path — hush redirects + busybox applets over the
// kernel FS RPCs (kernel.js FS_OPEN -> fs.open) — proving the kernel
// environment takes the fix, not just in-process BlockFS (which
// tests/blockfs/test_posix.js covers).
//
// Run: node tests/kernel/test_symlink_create_e2e.js
'use strict';
const { driveBoot, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

const script = [
  'mkdir /root/sc',
  'cd /root/sc',
  'ln -s /root/sc/t l',              // dangling: t does not exist yet
  'echo via-link > l',               // open(l, O_CREAT|O_WRONLY|O_TRUNC) via the FS RPCs

  'echo ==R1', 'ls',                 // must be exactly l + t, ONE dirent each
  'echo ==R2', 'cat t',              // the TARGET holds the bytes
  'echo ==R3', 'readlink l',         // l is still the symlink
  'echo ==R4', 'rm l', 'ls',         // rm removes the LINK only; t survives

  'ln -s /root/sc/c2 c1',            // chain: c1 -> c2 -> c3 (both dangling)
  'ln -s /root/sc/c3 c2',
  'echo chained > c1',
  'echo ==R5', 'cat c3',             // created at the chain's end
  'echo ==R6', 'ls',

  'ln -s /root/sc/td l2',
  'mkdir l2 2>&1',                   // POSIX: mkdir never follows the final symlink -> EEXIST
  'echo MKDIR_EXIT=$?',
  'echo ==R7', 'ls',                 // one l2, no td, no duplicate

  'echo ==DONE',
].join('\n');

const r = driveBoot(script, { prefix: 'symlink-create-e2e-', timeout: 300000 });
const out = String(r.stdout || '');
if (!out.includes('==DONE')) {
  console.error('boot did not complete\n--- stdout ---\n' + out + '\n--- stderr ---\n' + String(r.stderr || ''));
  process.exit(1);
}
const lines = (n) => section(out, n).split('\n').map(s => s.trim()).filter(Boolean);
const count = (n, name) => lines(n).filter(l => l === name).length;

check('R1: exactly one dirent named l (the symlink, no duplicate)', count('R1', 'l') === 1, lines('R1'));
check('R1: exactly one dirent named t (the created target)', count('R1', 't') === 1, lines('R1'));
check('R2: the target holds the redirected bytes', section(out, 'R2').trim() === 'via-link', section(out, 'R2').trim());
check('R3: l is still a symlink to /root/sc/t', section(out, 'R3').trim() === '/root/sc/t', section(out, 'R3').trim());
check('R4: rm l removed the link, not the target', count('R4', 'l') === 0 && count('R4', 't') === 1, lines('R4'));
check('R5: a dangling CHAIN creates at the chain end', section(out, 'R5').trim() === 'chained', section(out, 'R5').trim());
check('R6: one dirent each for c1/c2/c3', count('R6', 'c1') === 1 && count('R6', 'c2') === 1 && count('R6', 'c3') === 1, lines('R6'));
check('mkdir over a dangling symlink fails (EEXIST, POSIX)', /MKDIR_EXIT=[1-9]/.test(out), out.match(/MKDIR_EXIT=\d+/));
check('R7: mkdir left exactly one l2 and created no td', count('R7', 'l2') === 1 && count('R7', 'td') === 0, lines('R7'));

console.log(failures === 0 ? '\nsymlink-create e2e: PASS' : `\nsymlink-create e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
