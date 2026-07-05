#!/usr/bin/env node
// Phase 2 signals end-to-end (todos/0001): real C programs under a live
// kernel proving asynchronous delivery at safe points, EINTR vs SA_RESTART
// on waitpid, interruptible sleep(), pause(), blocked-signal survival with
// death-on-unblock as WIFSIGNALED, SIGCHLD to a catching parent, and the
// ordered exit(3) handshake.
//
// Helpers use 200ms delays to guarantee the target is parked inside the
// blocking call before the signal lands (the target reaches it in
// microseconds). The overall watchdog catches any hang.
//
// Run: node tests/kernel/test_signals_e2e.js
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

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const INIT_C = `
#include <spawn.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static volatile sig_atomic_t usr1s = 0;
static volatile sig_atomic_t chlds = 0;
static void on_usr1(int s) { (void)s; usr1s++; }
static void on_chld(int s) { (void)s; chlds++; }

static pid_t spawn1(const char *path, char *const argv[]) {
    pid_t pid;
    int e = posix_spawn(&pid, path, 0, 0, (char *const *)argv, 0);
    if (e) { printf("spawn %s failed %d\\n", path, e); exit(99); }
    return pid;
}
static pid_t spawn_helper(long us1, int pid1, int sig1, long us2, int pid2, int sig2) {
    char a1[24], a2[24], a3[24], a4[24], a5[24], a6[24];
    snprintf(a1, 24, "%ld", us1); snprintf(a2, 24, "%d", pid1); snprintf(a3, 24, "%d", sig1);
    char *argv[8]; int n = 0;
    argv[n++] = "helper"; argv[n++] = a1; argv[n++] = a2; argv[n++] = a3;
    if (pid2) {
        snprintf(a4, 24, "%ld", us2); snprintf(a5, 24, "%d", pid2); snprintf(a6, 24, "%d", sig2);
        argv[n++] = a4; argv[n++] = a5; argv[n++] = a6;
    }
    argv[n] = 0;
    return spawn1("/bin/helper", argv);
}

int main(void) {
    int st; pid_t r;
    int me = (int)getpid();

    /* 1: SIGCHLD to a catching parent + exit(3) handshake + output order */
    signal(SIGCHLD, on_chld);
    pid_t ex = spawn1("/bin/exiter", (char *const[]){ "exiter", 0 });
    r = waitpid(ex, &st, 0);
    printf("1 exiter reaped=%d code3=%d chld=%d\\n",
           r == ex, WIFEXITED(st) && WEXITSTATUS(st) == 3, (int)chlds);
    signal(SIGCHLD, SIG_DFL);   /* stop counting: later exits would coalesce nondeterministically */

    /* 2: EINTR — handler without SA_RESTART interrupts a blocked waitpid */
    signal(SIGUSR1, on_usr1);
    pid_t s1 = spawn1("/bin/sleeper", (char *const[]){ "sleeper", 0 });
    spawn_helper(200000, me, SIGUSR1, 0, 0, 0);
    errno = 0;
    r = waitpid(s1, &st, 0);
    printf("2 eintr=%d handler=%d\\n", r == -1 && errno == EINTR, (int)usr1s);
    kill(s1, SIGKILL);
    r = waitpid(s1, &st, 0);
    printf("2 sleeper killed=%d sig9=%d\\n", r == s1, WIFSIGNALED(st) && WTERMSIG(st) == SIGKILL);
    while (waitpid(-1, &st, 0) > 0) {}   /* reap the helper */

    /* 3: SA_RESTART — same shape, but the wait transparently restarts and
       completes when the helper SIGTERMs the sleeper */
    struct sigaction sa; memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_usr1; sa.sa_flags = SA_RESTART;
    sigaction(SIGUSR1, &sa, 0);
    pid_t s2 = spawn1("/bin/sleeper", (char *const[]){ "sleeper", 0 });
    spawn_helper(200000, me, SIGUSR1, 200000, (int)s2, SIGTERM);
    errno = 0;
    r = waitpid(s2, &st, 0);
    printf("3 restarted=%d sig15=%d handler=%d\\n",
           r == s2, WIFSIGNALED(st) && WTERMSIG(st) == SIGTERM, (int)usr1s);
    while (waitpid(-1, &st, 0) > 0) {}

    /* 4: interruptible sleep() — returns the unslept seconds */
    spawn_helper(200000, me, SIGUSR1, 0, 0, 0);
    unsigned left = sleep(100);
    printf("4 sleep_interrupted=%d handler=%d\\n", left >= 90, (int)usr1s);
    while (waitpid(-1, &st, 0) > 0) {}

    /* 5: pause() parks until a delivery, then EINTR */
    spawn_helper(200000, me, SIGUSR1, 0, 0, 0);
    int before = (int)usr1s;
    int pr = -99;
    errno = 0;
    while ((int)usr1s == before) pr = pause();
    printf("5 pause=%d eintr=%d handler=%d\\n",
           pr == -1, errno == EINTR, (int)usr1s == before + 1);
    while (waitpid(-1, &st, 0) > 0) {}

    /* 6: blocked SIGTERM survives; unblock dies as WIFSIGNALED */
    pid_t b = spawn1("/bin/blocker", (char *const[]){ "blocker", 0 });
    r = waitpid(b, &st, 0);
    printf("6 blocker sig15=%d\\n", r == b && WIFSIGNALED(st) && WTERMSIG(st) == SIGTERM);

    printf("done usr1s=%d chlds=%d\\n", (int)usr1s, (int)chlds);
    return 42;
}
`;

const SLEEPER_C = `
#include <unistd.h>
int main(void) { sleep(100); return 0; }
`;

// argv triples: delay_us pid sig [delay_us pid sig ...]
const HELPER_C = `
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
int main(int argc, char **argv) {
    for (int i = 1; i <= argc - 3; i += 3) {
        long us = atol(argv[i]);
        if (us > 0) usleep((unsigned)us);
        kill(atoi(argv[i + 1]), atoi(argv[i + 2]));
    }
    return 0;
}
`;

const BLOCKER_C = `
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
    sigset_t m; sigemptyset(&m); sigaddset(&m, SIGTERM);
    sigprocmask(SIG_BLOCK, &m, 0);
    char pidbuf[24]; snprintf(pidbuf, 24, "%d", (int)getpid());
    char *argv[] = { "helper", "0", pidbuf, "15", 0 };
    pid_t h; posix_spawn(&h, "/bin/helper", 0, 0, argv, 0);
    waitpid(h, 0, 0);            /* TERM is blocked: pends, does NOT interrupt */
    printf("blocker alive\\n"); fflush(stdout);
    sigprocmask(SIG_UNBLOCK, &m, 0);   /* delivery -> DFL -> die WIFSIGNALED */
    printf("blocker NOT REACHED\\n"); fflush(stdout);
    return 0;
}
`;

const EXITER_C = `
#include <stdio.h>
#include <stdlib.h>
int main(void) { printf("bye from exiter\\n"); exit(3); }
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-sig-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/sleeper', compile('sleeper', SLEEPER_C)],
  ['/bin/helper', compile('helper', HELPER_C)],
  ['/bin/blocker', compile('blocker', BLOCKER_C)],
  ['/bin/exiter', compile('exiter', EXITER_C)],
]);

// ---- boot ----
let out = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — signals e2e did not halt in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'bye from exiter',
    '1 exiter reaped=1 code3=1 chld=1',
    '2 eintr=1 handler=1',
    '2 sleeper killed=1 sig9=1',
    '3 restarted=1 sig15=1 handler=2',
    '4 sleep_interrupted=1 handler=3',
    '5 pause=1 eintr=1 handler=1',
    'blocker alive',
    '6 blocker sig15=1',
    'done usr1s=4 chlds=1',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('exactly ' + expect.length + ' lines', lines.length === expect.length, JSON.stringify(lines));
  check('process table empty after halt', kernel.processCount() === 0, String(kernel.processCount()));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsignals e2e: PASS' : `\nsignals e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
