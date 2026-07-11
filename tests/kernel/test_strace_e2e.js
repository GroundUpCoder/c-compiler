#!/usr/bin/env node
// strace e2e (todos/0046): the real /bin/strace in the booted OS via
// os/boot.js. Acceptance from the todo item: `strace cat FILE` shows
// open/read/write/close and the exit; the child's exit status propagates;
// a signal-delivering run shows the arrival marker in the RPC stream
// (sanity, not a format golden). Plus: -f descendant tracing with [pid N]
// prefixes, -o FILE output, and the ENOENT spawn-failure path.
//
// Run: node tests/kernel/test_strace_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-strace-');

const script = [
  'echo hi > /root/f',
  // Acceptance leg: the fd-syscall stream of a traced cat, to stderr.
  'strace cat /root/f 2>/root/tr1.txt',
  'echo rc1=$?',
  'echo ==tr1',
  'cat /root/tr1.txt',
  'echo ==tr1end',
  // Exit status propagation (exit and signal flavors).
  'strace sh -c "exit 7" 2>/dev/null',
  'echo rc2=$?',
  "strace sh -c 'kill -TERM $$' 2>/root/tr4.txt",
  'echo rc4=$?',
  'echo ==tr4',
  'cat /root/tr4.txt',
  'echo ==tr4end',
  // Spawn failure: loud message, shell-style 127.
  'strace /no/such/prog 2>/root/tr2.txt',
  'echo rc3=$?',
  'echo ==tr2',
  'cat /root/tr2.txt',
  'echo ==tr2end',
  // -f: the traced shell spawns cat; both pids appear, lines prefixed.
  "strace -f sh -c 'cat /root/f' 2>/root/tr3.txt",
  'echo ==tr3',
  'cat /root/tr3.txt',
  'echo ==tr3end',
  // -o FILE: trace lands in the file, stderr stays clean.
  'strace -o /root/tr5.txt cat /root/f 2>/root/err5.txt',
  'echo ==tr5',
  'cat /root/tr5.txt',
  'echo ==tr5end',
  'wc -c < /root/err5.txt',
  '',
].join('\n');

const run = driveBoot(script, { image, timeout: 240000 });
const out = run.stdout;
const section = (name) => (out.split('==' + name + '\n')[1] || '').split('==' + name + 'end')[0];

const tr1 = section('tr1');
check('traced cat still cats (stdout has the file, trace went to stderr)',
  out.startsWith('hi\n') || out.includes('\nhi\n'), out.split('\n').slice(0, 3).join('|'));
check('exit status propagates: rc1=0', out.includes('rc1=0'));
check('trace shows the open with the path and fd result',
  /FS_OPEN\(path="\/root\/f".*\) = \d+/.test(tr1), JSON.stringify(tr1));
check('trace shows the read with a data preview',
  /FS_READ\(fd=\d+, count=\d+\) = 3 "hi\\n"/.test(tr1), JSON.stringify(tr1));
check('trace shows the write to stdout',
  /FS_WRITE\(fd=1, data="hi\\n", count=3\) = 3/.test(tr1), JSON.stringify(tr1));
check('trace shows a close', tr1.includes('FS_CLOSE('), JSON.stringify(tr1));
check('trace shows the exit RPC and the exit marker',
  tr1.includes('EXIT(code=0)') && tr1.includes('+++ exited with 0 +++'),
  JSON.stringify(tr1));
check('no [pid] prefixes without -f', !tr1.includes('[pid '), JSON.stringify(tr1));

check('exit status propagates: rc2=7', out.includes('rc2=7'));

const tr4 = section('tr4');
check('signal run: SIGTERM arrival marker in the RPC stream',
  tr4.includes('--- SIGTERM ---'), JSON.stringify(tr4));
check('signal run: killed-by marker', tr4.includes('+++ killed by SIGTERM +++'),
  JSON.stringify(tr4));
check('signal run: strace exits 128+15', out.includes('rc4=143'));

check('spawn failure: rc3=127', out.includes('rc3=127'));
check('spawn failure: loud message', section('tr2').includes('strace: /no/such/prog'),
  JSON.stringify(section('tr2')));

const tr3 = section('tr3');
check('-f: lines are [pid N]-prefixed', tr3.includes('[pid '), JSON.stringify(tr3.slice(0, 400)));
check('-f: the child shell SPAWNs cat and the spawn is traced',
  /\[pid \d+\] SPAWN\(/.test(tr3), JSON.stringify(tr3.slice(0, 400)));
check('-f: more than one pid appears', (() => {
  const pids = new Set((tr3.match(/\[pid (\d+)\]/g) || []));
  return pids.size >= 2;
})(), JSON.stringify([...new Set(tr3.match(/\[pid (\d+)\]/g) || [])]));
check('-f: both exits marked', (tr3.match(/\+\+\+ exited with 0 \+\+\+/g) || []).length >= 2,
  JSON.stringify(tr3));

const tr5 = section('tr5');
check('-o FILE: trace written to the file',
  tr5.includes('FS_OPEN(path="/root/f"') && tr5.includes('+++ exited with 0 +++'),
  JSON.stringify(tr5.slice(0, 200)));
const tail = out.split('==tr5end\n')[1] || '';
check('-o FILE: stderr stayed clean (0 bytes)', /^\s*0\s*$/m.test(tail), JSON.stringify(tail));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
