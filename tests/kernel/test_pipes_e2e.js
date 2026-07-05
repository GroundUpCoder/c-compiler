#!/usr/bin/env node
// Phase 4 pipes end-to-end (todos/0003): real C processes in worker_threads
// over the brokered kernel prove the acceptance criteria:
//   - a cross-worker blocking pipe read is WOKEN by the writer's write
//     (the pre-kernel broker's no-wake-path hole, closed)
//   - fd_actions wire a pipe across posix_spawn (parent<->child and the
//     child<->child shell-pipeline shape)
//   - EOF: reader sees 0 when every write end is closed
//   - `yes | head`-shaped SIGPIPE death: an infinite writer dies with
//     WTERMSIG == SIGPIPE when the reader goes away
//
// Run: node tests/kernel/test_pipes_e2e.js
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>

static pid_t run(const char *what, posix_spawn_file_actions_t *fa) {
    char *argv[] = { "child", (char *)what, 0 };
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/child", fa, 0, argv, 0);
    if (e) { printf("spawn %s failed %d\\n", what, e); exit(99); }
    return pid;
}

int main(void) {
    int st, p[2]; pid_t pid; char buf[256]; ssize_t n;

    /* 1: child stdout -> pipe; the parent's blocking read is WOKEN by the
       child's (deliberately delayed) write, then sees EOF on child exit. */
    pipe(p);
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[1], 1);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    pid = run("late", &fa);
    posix_spawn_file_actions_destroy(&fa);
    close(p[1]);
    size_t got = 0;
    while (got < sizeof buf - 1 && (n = read(p[0], buf + got, sizeof buf - 1 - got)) > 0)
        got += (size_t)n;                  /* first read parks until the child writes */
    buf[got] = 0;
    close(p[0]);
    waitpid(pid, &st, 0);
    printf("late=[%s] eof=%d\\n", buf, n == 0);

    /* 2: yes|head shape — infinite writer, reader hangs up: SIGPIPE death */
    pipe(p);
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[1], 1);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    pid = run("spam", &fa);
    posix_spawn_file_actions_destroy(&fa);
    close(p[1]);
    size_t head = 0;                       /* take a head's worth (reads return */
    while (head < 8) {                     /* what's available, not the count)  */
        n = read(p[0], buf, 8 - head);
        if (n <= 0) break;
        head += (size_t)n;
    }
    close(p[0]);                           /* ...and hang up */
    waitpid(pid, &st, 0);
    printf("head=%d sigpipe=%d\\n", (int)head,
           WIFSIGNALED(st) && WTERMSIG(st) == SIGPIPE);

    /* 3: child | child — the shell-pipeline shape, no parent in the middle */
    pipe(p);
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[1], 1);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    pid_t producer = run("hello", &fa);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[0], 0);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    pid_t consumer = run("count", &fa);
    posix_spawn_file_actions_destroy(&fa);
    close(p[0]);
    close(p[1]);
    waitpid(producer, &st, 0);
    waitpid(consumer, &st, 0);
    printf("pipeline=%d\\n", WEXITSTATUS(st));   /* consumer exits with byte count */

    printf("done\\n");
    return 0;
}
`;

const CHILD_C = `
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
    const char *what = argc > 1 ? argv[1] : "";
    if (!strcmp(what, "late")) {
        usleep(250000);                    /* parent is parked in read() by now */
        write(1, "woken", 5);
        return 0;
    }
    if (!strcmp(what, "spam")) {
        for (;;) write(1, "y\\n", 2);      /* dies of SIGPIPE, never returns */
    }
    if (!strcmp(what, "hello")) {
        write(1, "HELLO-PIPE\\n", 11);
        return 0;
    }
    if (!strcmp(what, "count")) {
        char c; int total = 0;
        while (read(0, &c, 1) > 0) total++;
        return total;                      /* 11 for HELLO-PIPE\\n */
    }
    return 64;
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-pipes-'));
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
]);

// ---- boot brokered ----
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
kernel.createTty({ output: () => {} });

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\noutput:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', status === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'late=[woken] eof=1',
    'head=8 sigpipe=1',
    'pipeline=11',
    'done',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\npipes e2e: PASS' : `\npipes e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
