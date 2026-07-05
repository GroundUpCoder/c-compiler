#!/usr/bin/env node
// Phase 3 tty end-to-end (todos/0002): a real C program under a live kernel,
// driven interactively by a SCRIPTED UI BRIDGE — the same bytes-in/bytes-out
// protocol xterm.js will use, exercised headlessly (OS.md: this scripted
// bridge IS the agent-driving interface). Proves: canonical line reads with
// live erase editing, echo, ^C -> SIGINT interrupting a blocked read()
// (EINTR), raw mode via tcsetattr, SIGWINCH + TIOCGWINSZ, EOF, isatty.
//
// The driver waits for program-printed markers before feeding input, so
// every step is sequenced — no timing races.
//
// Run: node tests/kernel/test_tty_e2e.js
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
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <termios.h>
#include <unistd.h>
#include <errno.h>
#include <sys/ioctl.h>

static volatile sig_atomic_t ints = 0, winches = 0;
static void on_int(int s) { (void)s; ints++; }
static void on_winch(int s) { (void)s; winches++; }

int main(void) {
    char buf[128];

    printf("isatty=%d\\n", isatty(0));

    /* 1: canonical line read (the bridge types with a live erase) */
    printf("R1\\n");
    if (!fgets(buf, sizeof buf, stdin)) return 1;
    buf[strcspn(buf, "\\n")] = 0;
    printf("line=[%s]\\n", buf);

    /* 2: blocked read() interrupted by ^C */
    signal(SIGINT, on_int);
    printf("R2\\n");
    errno = 0;
    long n = read(0, buf, sizeof buf);
    printf("eintr=%d ints=%d\\n", n == -1 && errno == EINTR, (int)ints);

    /* 3: raw mode — three raw bytes, one read() each */
    struct termios t, orig;
    tcgetattr(0, &t);
    orig = t;
    cfmakeraw(&t);
    tcsetattr(0, TCSANOW, &t);
    printf("R3\\n");
    unsigned char c1, c2, c3;
    read(0, &c1, 1); read(0, &c2, 1); read(0, &c3, 1);
    printf("raw=[%c%c%c]\\n", c1, c2, c3);
    tcsetattr(0, TCSANOW, &orig);

    /* 4: SIGWINCH + TIOCGWINSZ */
    signal(SIGWINCH, on_winch);
    printf("R4\\n");
    while (!winches) pause();
    struct winsize ws;
    ioctl(0, TIOCGWINSZ, &ws);
    printf("winch=%d cols=%d rows=%d\\n", (int)winches, ws.ws_col, ws.ws_row);

    /* 5: EOF */
    printf("R5\\n");
    int ch = getchar();
    printf("eof=%d\\n", ch == EOF);
    return 42;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-tty-'));
const cFile = path.join(tmp, 'init.c');
const wasmFile = path.join(tmp, 'init.wasm');
fs.writeFileSync(cFile, INIT_C);
cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });
const image = fs.readFileSync(wasmFile);

// ---- boot with a scripted bridge ----
let out = '';
let echo = '';
const waiters = [];
function pump() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (out.includes(waiters[i].marker)) waiters.splice(i, 1)[0].resolve();
  }
}
function waitFor(marker) {
  return new Promise((resolve) => { waiters.push({ marker, resolve }); pump(); });
}

let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => (p === '/bin/init' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); pump(); },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});
const tty = kernel.createTty({
  cols: 80, rows: 24,
  output: (bytes) => { echo += Buffer.from(bytes).toString('latin1'); },
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\noutput:\n' + out + '\necho:\n' + JSON.stringify(echo));
  process.exit(1);
}, 60000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  await waitFor('R1');
  tty.input('helXo\x7f\x7flo\r');      // type, then erase "Xo", finish "lo"
  await waitFor('R2');
  tty.input('\x03');                   // ^C into a blocked read()
  await waitFor('R3');
  tty.input('xyz');                    // raw bytes
  await waitFor('R4');
  tty.resize(132, 43);
  await waitFor('R5');
  tty.eof();

  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'isatty=1',
    'R1',
    'line=[hello]',
    'R2',
    'eintr=1 ints=1',
    'R3',
    'raw=[xyz]',
    'R4',
    'winch=1 cols=132 rows=43',
    'R5',
    'eof=1',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('echo shows live erase editing', echo.includes('helXo\b \b\b \b') && echo.includes('lo\r\n'), JSON.stringify(echo));
  check('echo shows ^C', echo.includes('^C'), JSON.stringify(echo));
  check('raw bytes were not echoed', !echo.includes('xyz'), JSON.stringify(echo));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\ntty e2e: PASS' : `\ntty e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
