#!/usr/bin/env node
// End-to-end kernel test: real C programs compiled by compiler.js, run as
// worker_threads via nodeCreateWorker, talking to a live Kernel through the
// kernel-page block-RPC (KernelClient parked on Atomics.wait — the real
// transport, not the fake-worker shortcut of test_kernel.js).
//
// The process tree: init (pid 1) spawns /bin/child (argv + env inheritance,
// exit code through waitpid), then /bin/sleeper (parked in sleep(100)) which
// it SIGTERMs — proving kill() interrupts a blocked process and the termsig
// round-trips through wait status. init exits 42; the kernel halts.
//
// Run: node tests/kernel/test_e2e.js
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
#include <unistd.h>
extern char **environ;
int main(void) {
    /* 1: spawn a child that inherits env, prints, and exits 7 */
    char *argv1[] = { "child", "hello", 0 };
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/child", 0, 0, argv1, environ);
    if (e) { printf("spawn1 failed %d\\n", e); return 1; }
    int st = 0;
    pid_t w = waitpid(pid, &st, 0);
    printf("child pid=%d ok=%d exited=%d code=%d\\n",
           (int)pid, w == pid, WIFEXITED(st), WEXITSTATUS(st));

    /* 2: spawn a sleeper (blocked in sleep) and SIGTERM it */
    char *argv2[] = { "sleeper", 0 };
    e = posix_spawn(&pid, "/bin/sleeper", 0, 0, argv2, 0 /* inherit env */);
    if (e) { printf("spawn2 failed %d\\n", e); return 2; }
    kill(pid, SIGTERM);
    st = 0;
    w = waitpid(pid, &st, 0);
    printf("sleeper ok=%d signaled=%d sig=%d\\n",
           w == pid, WIFSIGNALED(st), WTERMSIG(st));

    /* 3: waitpid with no children left -> ECHILD (-1) */
    printf("nochild=%d\\n", (int)waitpid(-1, &st, 0));
    return 42;
}
`;

const CHILD_C = `
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
    printf("child says %s pid=%d ppid=%d FOO=%s\\n",
           argc > 1 ? argv[1] : "?", (int)getpid(), (int)getppid(),
           getenv("FOO") ? getenv("FOO") : "(unset)");
    return 7;
}
`;

const SLEEPER_C = `
#include <unistd.h>
int main(void) { sleep(100); return 0; }
`;

// ---- compile the three programs ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-e2e-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compile('init', INIT_C)],
  ['/bin/child', compile('child', CHILD_C)],
  ['/bin/sleeper', compile('sleeper', SLEEPER_C)],
]);

// ---- boot ----
let out = '';
let haltResolve;
const haltPromise = new Promise((r) => { haltResolve = r; });

const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — kernel e2e did not halt in 60s\noutput so far:\n' + out);
  process.exit(1);
}, 60000);

(async () => {
  const pid1 = await kernel.boot({
    path: '/bin/init', argv: ['init'], envp: ['FOO=bar'], cwd: '/',
  });
  check('booted as pid 1', pid1 === 1);

  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  check('process table empty after halt', kernel.processCount() === 0, String(kernel.processCount()));

  const lines = out.trim().split('\n');
  check('child ran with argv + env + ids', lines[0] === 'child says hello pid=2 ppid=1 FOO=bar', JSON.stringify(lines[0]));
  check('waitpid saw child exit 7', lines[1] === 'child pid=2 ok=1 exited=1 code=7', JSON.stringify(lines[1]));
  check('SIGTERM killed the blocked sleeper', lines[2] === 'sleeper ok=1 signaled=1 sig=15', JSON.stringify(lines[2]));
  check('no children left -> waitpid -1', lines[3] === 'nochild=-1', JSON.stringify(lines[3]));
  check('exactly 4 output lines', lines.length === 4, JSON.stringify(lines));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nkernel e2e: PASS' : `\nkernel e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
