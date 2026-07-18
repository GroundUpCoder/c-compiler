#!/usr/bin/env node
// realpath(3) / readlink -f resolve symlinks PHYSICALLY (todos/0263, gucOS #76).
//
// The bug: the RemoteFS-flavor realpath import (the one a booted gucOS uses)
// returned the LEXICAL normalizer (_resolvePath — collapse ./../// but keep
// every symlink component), so `realpath /bin/ls` echoed `/bin/ls` instead of
// resolving the /bin -> /usr/bin and /usr/bin/ls -> /usr/bin/coreutils links.
// Busybox `realpath` and `readlink -f` are both backed by libc realpath(), so
// both inherited it. The fix makes the kernel-side FS_REALPATH RPC resolve
// symlinks against the real fs (host.js physicalRealpath, one RPC — the walk's
// lstat/readlink hops stay kernel-local), matching the standalone-Node flavor
// (fs.realpathSync) exactly.
//
// This drives the REAL busybox coreutils applets over the REAL baked symlink
// layout — the exact commands the ticket names. Stable links present in ANY
// boot (minimal or fat): /bin -> /usr/bin, /usr/bin/ls -> /usr/bin/coreutils,
// /usr/local -> /var/local. Runtime links exercise relative targets + '..' and
// an ELOOP cycle.
//
// Run: node tests/kernel/test_realpath_e2e.js
'use strict';
const { driveBoot, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

// One session: build the runtime links, then probe realpath/readlink -f. Each
// answer is fenced by ==Rn markers so the parse is position-independent.
const script = [
  'mkdir -p /root/rp/y /root/rp/z',
  'ln -s ../z /root/rp/y/rel',            // relative target resolved against the link's parent
  'ln -s /root/rp/y/rel /root/rp/chain',  // a second hop onto the relative link
  'ln -s /root/la /root/lb',              // an ELOOP cycle: la -> lb -> la
  'ln -s /root/lb /root/la',

  'echo ==R1', 'realpath /bin/ls',                       // /bin->/usr/bin, ls->coreutils
  'echo ==R2', 'readlink -f /bin/ls',                    // same, via readlink -f
  'echo ==R3', 'readlink /bin/ls',                       // final component's link target
  'echo ==R4', 'realpath /usr/local',                    // baked /usr/local -> /var/local
  'echo ==R5', 'realpath /usr/local/bin',                // resolves through it
  'echo ==R6', 'realpath /bin',                          // the bare /bin symlink
  'echo ==R7', 'realpath /root/rp/y/rel',                // ../z relative target + '..'
  'echo ==R8', 'realpath /root/rp/chain',                // chained onto the relative link
  'echo ==R9', 'realpath /root/la; echo R9EXIT=$?',      // ELOOP -> error, nonzero exit
  'echo ==R10', 'readlink -f /root/la; echo R10EXIT=$?', // readlink -f shares the cycle failure
  'echo ==R11', 'realpath /root/rp/y/nope',              // missing final: busybox wrapper re-appends over the existing dir
  'echo ==R12', 'readlink -f /root/rp/y/nope',           // readlink -f does the same
  'echo ==DONE',
].join('\n');

const r = driveBoot(script, { prefix: 'realpath-e2e-', timeout: 300000 });
const out = String(r.stdout || '');
if (!out.includes('==DONE')) {
  console.error('boot did not complete\n--- stdout ---\n' + out + '\n--- stderr ---\n' + String(r.stderr || ''));
  process.exit(1);
}
const sec = (n) => section(out, n).trim();

// The headline: physical resolution through the merged-usr + applet links.
check('R1: realpath /bin/ls -> /usr/bin/coreutils (2-hop cross-mount chain)',
  sec('R1') === '/usr/bin/coreutils', sec('R1'));
check('R2: readlink -f /bin/ls matches realpath (same libc realpath path)',
  sec('R2') === '/usr/bin/coreutils', sec('R2'));
check('R3: readlink /bin/ls -> final component target /usr/bin/coreutils',
  sec('R3') === '/usr/bin/coreutils', sec('R3'));
check('R4: realpath /usr/local -> /var/local (baked escape symlink)',
  sec('R4') === '/var/local', sec('R4'));
check('R5: realpath /usr/local/bin -> /var/local/bin (resolves through it)',
  sec('R5') === '/var/local/bin', sec('R5'));
check('R6: realpath /bin -> /usr/bin (the merged-usr symlink itself)',
  sec('R6') === '/usr/bin', sec('R6'));
check('R7: realpath /root/rp/y/rel -> /root/rp/z (relative ../z target + ..)',
  sec('R7') === '/root/rp/z', sec('R7'));
check('R8: realpath /root/rp/chain -> /root/rp/z (chained onto the relative link)',
  sec('R8') === '/root/rp/z', sec('R8'));

// ELOOP: both commands must FAIL (nonzero), not print a resolved path.
const r9 = sec('R9');
check('R9: realpath of an ELOOP cycle fails (nonzero exit, no path printed)',
  /R9EXIT=[1-9]/.test(r9) && !r9.includes('/root/la') && !r9.includes('/root/lb'), r9);
check('R10: readlink -f of the same cycle also fails',
  /R10EXIT=[1-9]/.test(sec('R10')) && !sec('R10').includes('/root/l'), sec('R10'));

// Missing final component: libc realpath() returns ENOENT (fs.realpathSync /
// glibc semantics), which is exactly what makes busybox's shared coreutils
// wrapper (used by BOTH `realpath` and `readlink -f`) resolve the existing
// PARENT physically and re-append the missing tail. We must not have broken
// that: both commands succeed and canonicalize the prefix.
check('R11: realpath of a missing final re-appends over the physically-resolved parent',
  sec('R11') === '/root/rp/y/nope', sec('R11'));
check('R12: readlink -f of a missing final does the same (parity)',
  sec('R12') === '/root/rp/y/nope', sec('R12'));

console.log(failures === 0 ? '\nrealpath e2e: PASS' : `\nrealpath e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
