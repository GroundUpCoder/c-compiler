#!/usr/bin/env node
// vDSO page end-to-end (todos/0179): a REAL C program compiled by
// compiler.js runs as a worker_thread under the kernel and reads its
// pid/ppid/pgrp/sid off the published page. The kernel's RPC dispatch is
// wrapped with an op counter — the acceptance is that the whole run makes
// ZERO GETPGID/GETSID RPCs while every printed value is correct, including
// ACROSS the mutations that change them:
//   - a spawned child sees its inherited pgid/sid, calls setsid(), and
//     reads the new session from the page (the deliberate SETSID is the
//     only session RPC in the trace)
//   - an orphaned grandchild's getppid() flips to 1 when the kernel
//     reparents it — the spawn-time static would have gone stale
//
// Run: node tests/kernel/test_vdso_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "c1") == 0) {
        /* spawned child: inherited group/session off the page, then the
           setsid mutation is visible with no further session RPCs */
        printf("C1A pid=%d ppid=%d pgrp=%d sid=%d\\n",
               getpid(), getppid(), getpgrp(), (int)getsid(0));
        int s = setsid();
        printf("C1B setsid=%d pgrp=%d sid=%d\\n", s, getpgrp(), (int)getsid(0));
        fflush(stdout);
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "c2") == 0) {
        /* middle link: spawn the grandchild and exit WITHOUT waiting */
        char *cargv[] = { "app", "c3", 0 };
        pid_t pid;
        int e = posix_spawn(&pid, "/bin/app", 0, 0, cargv, 0);
        printf("C2 err=%d\\n", e);
        fflush(stdout);
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "c3") == 0) {
        /* orphan-to-be: getppid() flips to 1 at the reparent */
        int i;
        printf("C3A ppid=%d\\n", getppid());
        for (i = 0; i < 500 && getppid() != 1; i++) usleep(10000);
        printf("C3B ppid=%d\\n", getppid());
        fflush(stdout);
        return 0;
    }
    /* init (pid 1) */
    printf("P pid=%d ppid=%d pgrp=%d sid=%d\\n",
           getpid(), getppid(), getpgrp(), (int)getsid(0));
    fflush(stdout);
    char *c1argv[] = { "app", "c1", 0 };
    char *c2argv[] = { "app", "c2", 0 };
    pid_t pid; int st;
    posix_spawn(&pid, "/bin/app", 0, 0, c1argv, 0);
    waitpid(pid, &st, 0);
    posix_spawn(&pid, "/bin/app", 0, 0, c2argv, 0);
    waitpid(pid, &st, 0);
    /* the orphan reparents to us; reap it so its output is complete */
    pid_t any = waitpid(-1, &st, 0);
    printf("REAPED=%d\\n", any > 0 ? 1 : 0);
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdso-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);

let out = '';
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});
kernel.createTty({ cols: 80, rows: 24, output: () => {} });

// The RPC-op counter: every brokered syscall funnels through _dispatchRpc
// with the opcode already on the page, so this sees the complete traffic.
const rpcOps = [];
const origDispatch = kernel._dispatchRpc;
kernel._dispatchRpc = function (pcb) {
  rpcOps.push(Atomics.load(pcb.i32, K.KP_RPC_OP));
  return origDispatch.call(this, pcb);
};

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const line = (tag) => out.split('\n').find((l) => l.startsWith(tag + ' ')) || '';
const field = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — vdso e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('DONE');

  // Values: init's identity off the page.
  check('P: pid=1 ppid=0', field('P', 'pid') === 1 && field('P', 'ppid') === 0, line('P'));
  check('P: pgrp=1 sid=1', field('P', 'pgrp') === 1 && field('P', 'sid') === 1, line('P'));

  // Values: the child's inherited group, then the setsid mutation.
  const c1pid = field('C1A', 'pid');
  check('C1A: inherited pgrp=1 sid=1, ppid=1', field('C1A', 'pgrp') === 1 &&
    field('C1A', 'sid') === 1 && field('C1A', 'ppid') === 1, line('C1A'));
  check('C1B: setsid succeeded and the page shows the new session',
    field('C1B', 'setsid') === c1pid && field('C1B', 'sid') === c1pid &&
    field('C1B', 'pgrp') === c1pid, line('C1B'));

  // Values: the orphan's getppid() tracked the reparent.
  check('C2 spawned the orphan cleanly', field('C2', 'err') === 0, line('C2'));
  check('C3B: getppid() flipped to 1 at the reparent', field('C3B', 'ppid') === 1, line('C3B'));
  check('init reaped the reparented orphan', out.includes('REAPED=1'), out);

  // The acceptance: zero session RPCs from four processes' worth of
  // getpgrp/getsid/getppid reads; the ONE deliberate setsid is the only
  // session-family opcode in the trace.
  const pgidRpcs = rpcOps.filter((op) => op === K.OP.GETPGID).length;
  const sidRpcs = rpcOps.filter((op) => op === K.OP.GETSID).length;
  const setsids = rpcOps.filter((op) => op === K.OP.SETSID).length;
  check('zero GETPGID RPCs', pgidRpcs === 0, String(pgidRpcs));
  check('zero GETSID RPCs', sidRpcs === 0, String(sidRpcs));
  check('exactly the one deliberate SETSID', setsids === 1, String(setsids));

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nvdso e2e: PASS' : `\nvdso e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
