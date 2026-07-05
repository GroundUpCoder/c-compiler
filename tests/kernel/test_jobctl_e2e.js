#!/usr/bin/env node
// Phase 4 job control end-to-end (todos/0003): real C in worker_threads.
// A ticker child emits a byte every 50ms; the JS harness (as the embedder)
// sends SIGSTOP/SIGCONT/SIGTERM while the C init observes the transitions
// through waitpid(WUNTRACED / WCONTINUED / 0). Proves:
//   - the stop is REAL: the ticker's output halts while stopped (the worker
//     parks in sigpoll at a safe point) and resumes on SIGCONT
//   - waitpid reports each transition once, with the POSIX status encodings
//     (WIFSTOPPED/WSTOPSIG, WIFCONTINUED, then WIFSIGNALED for the SIGTERM)
//
// Run: node tests/kernel/test_jobctl_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT_C = `
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>

int main(void) {
    char *argv[] = { "ticker", 0 };
    pid_t pid;
    int st;
    if (posix_spawn(&pid, "/bin/ticker", 0, 0, argv, 0)) return 99;
    printf("child=%d\\n", (int)pid);

    waitpid(pid, &st, WUNTRACED);
    printf("stopped=%d sig=%d\\n", WIFSTOPPED(st), WSTOPSIG(st));

    waitpid(pid, &st, WCONTINUED);
    printf("continued=%d\\n", WIFCONTINUED(st));

    waitpid(pid, &st, 0);
    printf("termed=%d sig=%d\\n", WIFSIGNALED(st), WTERMSIG(st));
    return 0;
}
`;

const TICKER_C = `
#include <unistd.h>
int main(void) {
    for (;;) {                 /* every write/usleep return is a safe point */
        write(1, ".", 1);
        usleep(50000);
    }
    return 0;
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-jobctl-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/ticker', compile('ticker', TICKER_C)],
]);

// ---- boot brokered; track output per pid ----
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);

const perPid = new Map();
let initOut = '';
const waiters = [];
function pump() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (initOut.includes(waiters[i].marker)) waiters.splice(i, 1)[0].resolve();
  }
}
const waitFor = (marker) => new Promise((resolve) => { waiters.push({ marker, resolve }); pump(); });

let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => {
    const s = Buffer.from(bytes).toString();
    perPid.set(pid, (perPid.get(pid) || '') + s);
    if (pid === 1) { initOut += s; pump(); }
  },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});
kernel.createTty({ output: () => {} });

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\ninit output:\n' + initOut);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  await waitFor('child=');
  const tickerPid = parseInt(initOut.match(/child=(\d+)/)[1], 10);
  check('ticker pid reported', tickerPid > 1, String(tickerPid));

  // Let it tick, then stop it and prove the output actually halts.
  await sleep(400);
  kernel.kill(tickerPid, 19);                     // SIGSTOP (embedder-initiated)
  await waitFor('stopped=');
  check('kernel state is stopped', kernel.process(tickerPid).state === 'stopped');
  await sleep(200);                               // drain any in-flight tick
  const frozen = (perPid.get(tickerPid) || '').length;
  check('ticker ticked before the stop', frozen > 0, String(frozen));
  await sleep(500);
  const still = (perPid.get(tickerPid) || '').length;
  check('output halts while stopped', still === frozen, still + ' vs ' + frozen);

  kernel.kill(tickerPid, 18);                     // SIGCONT
  await waitFor('continued=');
  await sleep(400);
  const resumed = (perPid.get(tickerPid) || '').length;
  check('output resumes after SIGCONT', resumed > still, resumed + ' vs ' + still);

  kernel.kill(tickerPid, 15);                     // SIGTERM
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', status === 0, String(status));
  const lines = initOut.trim().split('\n');
  check('waitpid(WUNTRACED) saw the stop', lines[1] === 'stopped=1 sig=19', JSON.stringify(lines[1]));
  check('waitpid(WCONTINUED) saw the continue', lines[2] === 'continued=1', JSON.stringify(lines[2]));
  check('waitpid saw the SIGTERM death', lines[3] === 'termed=1 sig=15', JSON.stringify(lines[3]));
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\njob control e2e: PASS' : `\njob control e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
