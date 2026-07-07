#!/usr/bin/env node
// Pty end-to-end (todos/0020): real C processes in worker_threads over the
// brokered kernel prove the C surface — openpty() + TIOCSWINSZ from
// <pty.h>/<sys/ioctl.h>, spawn-on-slave via fd_actions, the line
// discipline round trip (ICRNL in, echo + ONLCR out), TIOCGWINSZ through
// the pty's winsize SAB, SIGWINCH on master resize, and master-close EOF
// for a read-parked slave holder.
//
// Run: node tests/kernel/test_pty_e2e.js
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

// The terminal-app role: owns the master, scripts the session.
const INIT_C = `
#include <pty.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/wait.h>

static char acc[65536];
static size_t alen = 0;
static int mfd;

static void pump_until(const char *marker) {
    while (!strstr(acc, marker)) {
        ssize_t n = read(mfd, acc + alen, sizeof acc - 1 - alen);
        if (n <= 0) { printf("EARLY-EOF waiting for %s\\n", marker); exit(97); }
        alen += (size_t)n;
        acc[alen] = 0;
    }
}

int main(void) {
    int sfd;
    if (openpty(&mfd, &sfd, 0, 0, 0) != 0) { printf("openpty failed\\n"); return 98; }
    printf("isatty m=%d s=%d\\n", isatty(mfd), isatty(sfd));
    struct winsize ws = { 30, 100, 0, 0 };
    ioctl(mfd, TIOCSWINSZ, &ws);

    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, sfd, 0);
    posix_spawn_file_actions_adddup2(&fa, sfd, 1);
    posix_spawn_file_actions_adddup2(&fa, sfd, 2);
    posix_spawn_file_actions_addclose(&fa, mfd);
    posix_spawn_file_actions_addclose(&fa, sfd);
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);
    char *cargv[] = { "child", 0 };
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/child", &fa, &at, cargv, 0);
    if (e) { printf("spawn failed %d\\n", e); return 99; }
    posix_spawn_file_actions_destroy(&fa);
    close(sfd);                       /* the child holds the only slave refs */

    pump_until("WS 30 100\\r\\n");     /* child saw the pre-spawn winsize */
    write(mfd, "hi there\\r", 9);      /* ICRNL cooks the CR to NL */
    pump_until("GOT [hi there]\\r\\n");
    pump_until("WAITING\\r\\n");
    printf("echo=%d\\n", strstr(acc, "hi there\\r\\n") != 0);
    struct winsize ws2 = { 31, 101, 0, 0 };
    ioctl(mfd, TIOCSWINSZ, &ws2);      /* SIGWINCH to the child */
    pump_until("WINCH 31 101\\r\\n");
    printf("tty=%d\\n", strstr(acc, "TTY 1\\r\\n") != 0);
    close(mfd);                        /* hang up: the parked child read EOFs */
    int st;
    waitpid(pid, &st, 0);
    printf("exit5=%d\\n", WIFEXITED(st) && WEXITSTATUS(st) == 5);
    printf("done\\n");
    return 0;
}
`;

// The shell role: lives on the slave, reports what it sees.
const CHILD_C = `
#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>

static volatile int winched = 0;
static void on_winch(int sig) { (void)sig; winched = 1; }

int main(void) {
    struct winsize ws;
    signal(SIGHUP, SIG_IGN);           /* survive the master's hangup */
    signal(SIGWINCH, on_winch);
    printf("TTY %d\\n", isatty(0));
    ioctl(0, TIOCGWINSZ, &ws);
    printf("WS %d %d\\n", ws.ws_row, ws.ws_col);
    fflush(stdout);
    char line[64];
    int n = read(0, line, sizeof line - 1);
    if (n < 0) n = 0;
    line[n] = 0;
    if (n && line[n-1] == '\\n') line[n-1] = 0;
    printf("GOT [%s]\\n", line);
    printf("WAITING\\n");
    fflush(stdout);
    while (!winched) pause();
    ioctl(0, TIOCGWINSZ, &ws);
    printf("WINCH %d %d\\n", ws.ws_row, ws.ws_col);
    fflush(stdout);
    char c;
    while ((n = read(0, &c, 1)) > 0) {}
    return 5;                          /* clean EOF exit marker */
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-pty-'));
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
    'isatty m=1 s=1',
    'echo=1',
    'tty=1',
    'exit5=1',
    'done',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\npty e2e: PASS' : `\npty e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
