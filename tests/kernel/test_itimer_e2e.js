#!/usr/bin/env node
// Interval timers end-to-end (todos/0044): real C programs under a live
// kernel proving alarm()/setitimer(ITIMER_REAL) -> SIGALRM through the
// cooperative delivery path — the classic alarm-timeout idiom (EINTR on a
// blocked pipe read), repeating it_interval fires, getitimer remaining
// values, alarm(0)/setitimer-zero cancellation, ualarm, EINVAL for the
// CPU-time flavors, and the default action (no handler) terminating as
// WIFSIGNALED(SIGALRM).
//
// Timings: timers are 100-200ms against multi-second watchdogs — generous
// margins, no exact-deadline asserts (booleans only, so scheduling jitter
// can't flake the goldens).
//
// Run: node tests/kernel/test_itimer_e2e.js
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

const INIT_C = `
#include <spawn.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static volatile sig_atomic_t alrms = 0;
static void on_alrm(int s) { (void)s; alrms++; }

int main(void) {
    signal(SIGALRM, on_alrm);   /* no SA_RESTART: interrupted reads surface EINTR */

    /* 1: the classic timeout idiom — alarm(1) EINTRs a blocked pipe read */
    int fds[2];
    if (pipe(fds) != 0) { printf("pipe failed\\n"); return 99; }
    alarm(1);
    char buf[8];
    errno = 0;
    long n = read(fds[0], buf, sizeof buf);   /* empty pipe, writer open: blocks */
    printf("1 read_eintr=%d handler=%d\\n", n == -1 && errno == EINTR, (int)alrms);
    printf("1 alarm0_spent=%d\\n", alarm(0) == 0);   /* already fired: nothing left */

    /* 2: no CPU accounting — the virtual/profiling flavors fail loud */
    struct itimerval it, old, cur;
    memset(&it, 0, sizeof it);
    it.it_value.tv_usec = 100000;
    errno = 0;
    int rv = setitimer(ITIMER_VIRTUAL, &it, 0);
    printf("2 einval=%d\\n", rv == -1 && errno == EINVAL);

    /* 3: it_interval fires repeatedly; getitimer reads sane values */
    it.it_value.tv_sec = 0;  it.it_value.tv_usec = 100000;
    it.it_interval = it.it_value;
    setitimer(ITIMER_REAL, &it, 0);
    while (alrms < 4) pause();
    getitimer(ITIMER_REAL, &cur);
    printf("3 repeat=%d cur_sane=%d interval_keeps=%d\\n", alrms >= 4,
           cur.it_value.tv_sec == 0 && cur.it_value.tv_usec > 0 && cur.it_value.tv_usec <= 100000,
           cur.it_interval.tv_sec == 0 && cur.it_interval.tv_usec == 100000);
    memset(&it, 0, sizeof it);
    setitimer(ITIMER_REAL, &it, &old);        /* disarm */
    printf("3 old_interval=%d\\n", old.it_interval.tv_usec == 100000);
    usleep(50000);                            /* drain a raced, already-pending fire */
    int before = (int)alrms;
    usleep(250000);
    printf("3 disarmed=%d\\n", (int)alrms == before);

    /* 4: alarm(0) cancels and reports the seconds remaining (rounded up) */
    printf("4 arm_ret0=%d\\n", alarm(5) == 0);
    printf("4 cancel_rem=%d\\n", alarm(0) == 5);
    before = (int)alrms;
    usleep(200000);
    printf("4 cancelled=%d\\n", (int)alrms == before);

    /* 5: a new alarm replaces the old one and returns its remainder */
    alarm(100);
    printf("5 replace_prev=%d\\n", alarm(0) == 100);

    /* 6: ualarm — microseconds in, same SIGALRM out */
    before = (int)alrms;
    printf("6 uret0=%d\\n", ualarm(150000, 0) == 0);
    while ((int)alrms == before) pause();
    printf("6 ualarm=%d\\n", (int)alrms == before + 1);

    /* 7: default action (no handler installed) terminates the process */
    signal(SIGALRM, SIG_DFL);
    pid_t d;
    char *dargv[] = { "alrmdfl", 0 };
    int e = posix_spawn(&d, "/bin/alrmdfl", 0, 0, dargv, 0);
    if (e) { printf("spawn alrmdfl failed %d\\n", e); return 99; }
    int st; pid_t r = waitpid(d, &st, 0);
    printf("7 dfl_killed=%d sig14=%d\\n", r == d, WIFSIGNALED(st) && WTERMSIG(st) == SIGALRM);

    printf("done alrms=%d\\n", (int)alrms);
    return 42;
}
`;

// No handler: SIGALRM's default action must terminate this out of pause().
const ALRMDFL_C = `
#include <sys/time.h>
#include <signal.h>   /* pause() lives with the signal surface in this libc */
#include <unistd.h>
int main(void) {
    struct itimerval it = { { 0, 0 }, { 0, 200000 } };
    setitimer(ITIMER_REAL, &it, 0);
    for (;;) pause();
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-itimer-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/alrmdfl', compile('alrmdfl', ALRMDFL_C)],
]);

// ---- boot ----
// Brokered fs: leg 1's blocking pipe read must be a kernel OFD (a deferred
// FS_READ the SIGALRM post can interrupt) — without opts.fs pipes are
// in-process and read(2) can't park.
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);
let out = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — itimer e2e did not halt in 60s\noutput so far:\n' + out);
  process.exit(1);
}, 60000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    '1 read_eintr=1 handler=1',
    '1 alarm0_spent=1',
    '2 einval=1',
    '3 repeat=1 cur_sane=1 interval_keeps=1',
    '3 old_interval=1',
    '3 disarmed=1',
    '4 arm_ret0=1',
    '4 cancel_rem=1',
    '4 cancelled=1',
    '5 replace_prev=1',
    '6 uret0=1',
    '6 ualarm=1',
    '7 dfl_killed=1 sig14=1',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('done line present', /^done alrms=\d+$/.test(lines[expect.length] || ''), JSON.stringify(lines[expect.length]));
  check('exactly ' + (expect.length + 1) + ' lines', lines.length === expect.length + 1, JSON.stringify(lines));
  check('process table empty after halt', kernel.processCount() === 0, String(kernel.processCount()));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nitimer e2e: PASS' : `\nitimer e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
