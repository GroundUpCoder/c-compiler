#!/usr/bin/env node
// REPLs-over-pty e2e (todos/0036): the three seeded interpreters — lua,
// micropython, sqlite3 — driven interactively on a kernel pty by a real C
// master (openpty + spawn-on-slave, the /bin/term shape). Proves per REPL:
//   - the banner and prompt arrive through the slave's line discipline
//   - a typed expression evaluates and prints (canonical mode delivers
//     whole lines; micropython's own readline sits happily behind it)
//   - canonical-mode erase: \x7f backspaces are resolved by the LD before
//     micropython's readline ever sees the line
//   - ^D at an empty prompt is EOF, and EOF EXITS the REPL — the
//     spins-on-stdin-EOF class (fixed for mp in uart_core.c) stays fixed
//     over the pty path too
//
// The interpreter binaries are the real vendor bin.json builds (the same
// projects os/image.json seeds), compiled here by the CLI — this test is
// deliberately heavier than the toy-C e2es (~8s of compile) because it is
// the headless twin of "open term, type at the REPL".
//
// Run: node tests/kernel/test_repl_pty_e2e.js
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

// The terminal-app role: one pty session per REPL, scripted.
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

static pid_t start(const char *bin) {
    int m, s;
    if (openpty(&m, &s, 0, 0, 0) != 0) { printf("openpty failed\\n"); exit(98); }
    struct winsize ws = { 24, 80, 0, 0 };
    ioctl(m, TIOCSWINSZ, &ws);
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, s, 0);
    posix_spawn_file_actions_adddup2(&fa, s, 1);
    posix_spawn_file_actions_adddup2(&fa, s, 2);
    posix_spawn_file_actions_addclose(&fa, m);
    posix_spawn_file_actions_addclose(&fa, s);
    /* Own pgroup: the slave's first attach claims it as foreground, so the
       master-close SIGHUP lands on the (already-exited) REPL, not on us. */
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);
    char *cargv[] = { (char *)bin, 0 };
    pid_t pid;
    int e = posix_spawn(&pid, bin, &fa, &at, cargv, 0);
    if (e) { printf("spawn %s failed %d\\n", bin, e); exit(99); }
    posix_spawn_file_actions_destroy(&fa);
    close(s);                          /* the child holds the only slave refs */
    mfd = m;
    acc[0] = 0; alen = 0;
    return pid;
}

/* ^D on an empty line: sticky EOF through the LD — the REPL must EXIT
   (the spins-on-EOF class), status 0. */
static int finish(pid_t pid) {
    write(mfd, "\\x04", 1);
    int st;
    waitpid(pid, &st, 0);
    close(mfd);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0;
}

int main(void) {
    pid_t pid;
    setvbuf(stdout, 0, _IONBF, 0);

    /* lua: fgets-style line reads over canonical mode.
       Result markers are "\\r\\n42\\r" (not "...42\\r\\n"): micropython
       emits \\r\\n itself and the slave's ONLCR doubles the \\r, so the
       result line frames as \\r\\n42\\r\\r\\n over the pty. */
    pid = start("/bin/lua");
    pump_until("> ");
    printf("lua_banner=%d\\n", strstr(acc, "Lua 5.5") != 0);
    write(mfd, "print(6*7)\\r", 11);
    pump_until("\\r\\n42\\r");
    printf("lua_eof=%d\\n", finish(pid));

    /* micropython: its own line editor behind the pty's canonical LD */
    pid = start("/bin/micropython");
    pump_until(">>> ");
    printf("mp_banner=%d\\n", strstr(acc, "MicroPython v") != 0);
    write(mfd, "print(6*7)\\r", 11);
    pump_until("\\r\\n42\\r");
    /* canonical erase: the LD resolves the \\x7f backspaces before mp's
       readline sees the line — a failed erase evaluates print(9913),
       never matches, and trips the watchdog */
    write(mfd, "print(99" "\\x7f" "\\x7f" "13)\\r", 14);
    pump_until("\\r\\n13\\r");
    printf("mp_edit=1\\n");
    printf("mp_eof=%d\\n", finish(pid));

    /* sqlite3: line REPL, isatty(0) on the slave turns prompts on — and
       with them the interactive default of box-drawn result tables, so a
       dot command flips to list mode first (a dot-command check for free) */
    pid = start("/bin/sqlite3");
    pump_until("sqlite> ");
    printf("sq_banner=%d\\n", strstr(acc, "SQLite version") != 0);
    write(mfd, ".mode list\\r", 11);
    write(mfd, "select 6*7;\\r", 12);
    /* both lines echo before the intermediate prompt, so the result
       follows "sqlite> " — no leading newline. "42\\r" appears nowhere
       else in this session (banner, echoes, prompts). */
    pump_until("42\\r");
    printf("sq_eof=%d\\n", finish(pid));

    printf("done\\n");
    return 0;
}
`;

// ---- compile: the toy master by source, the REPLs as their real vendor
// bin.json projects (exactly what os/image.json seeds) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-repl-'));
function compileSrc(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
function compileProject(binJson) {
  const wasm = path.join(tmp, path.basename(path.dirname(binJson)) + '.wasm');
  cp.execFileSync('node', [COMPILER, path.join(ROOT, binJson), '-o', wasm],
    { stdio: 'pipe', cwd: ROOT });
  return fs.readFileSync(wasm);
}
const images = new Map([
  ['/bin/init', compileSrc('init', INIT_C)],
  ['/bin/lua', compileProject('vendor/lua/bin.json')],
  ['/bin/micropython', compileProject('vendor/micropython/bin.json')],
  ['/bin/sqlite3', compileProject('vendor/sqlite/bin.json')],
]);

// ---- boot brokered ----
const store = new BLOCK_FS.MemoryByteStore(16 << 20);
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
}, 120000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', status === 0, String(status));
  const lines = out.trim().split('\n');
  const expect = [
    'lua_banner=1',
    'lua_eof=1',
    'mp_banner=1',
    'mp_edit=1',
    'mp_eof=1',
    'sq_banner=1',
    'sq_eof=1',
    'done',
  ];
  for (let i = 0; i < expect.length; i++) {
    check(JSON.stringify(expect[i]), lines[i] === expect[i], JSON.stringify(lines[i]));
  }
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));
  if (failures) console.log('---- raw init output ----\n' + out + '\n----');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nREPL pty e2e: PASS' : `\nREPL pty e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
