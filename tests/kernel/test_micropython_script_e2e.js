#!/usr/bin/env node
// MicroPython script-runner e2e (todos/0117 R1). The sibling of
// test_repl_pty_e2e.js: that one proves the INTERACTIVE REPL over a pty,
// this one proves the CLI — `micropython foo.py args`, which before R1
// silently ignored argv and dropped into the REPL instead.
//
// A real C init spawns the real vendor bin.json build as an OS process and
// checks, through the kernel's fd-tagged output and waitpid status:
//   - a script FILE is compiled and run, and sys.argv is [script, ...args]
//   - open() round-trips a file on the kernel-owned BlockFS (write + read)
//   - `import mymod` finds /root/mymod.py through mp_import_stat + the
//     POSIX lexer (sys.path[0] is "", i.e. cwd)
//   - sys.exit(N) becomes the process exit status
//   - an uncaught exception exits 1 and puts its traceback on fd 2, NOT
//     fd 1 (a CLI that prints errors to stdout corrupts `python x.py > out`)
//   - -c CMD runs a command string
//
// Run: node tests/kernel/test_micropython_script_e2e.js
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

const HELLO_PY = [
  'import sys',
  'print("argv=" + repr(sys.argv))',
  'with open("/root/out.txt", "w") as f:',
  '    f.write("round-trip\\n")',
  'print("read=" + open("/root/out.txt").read().strip())',
  'import mymod',
  'print("mod=" + mymod.greet("os"))',
  'print("file=" + __file__)',
].join('\n') + '\n';

const MYMOD_PY = 'def greet(who):\n    return "hi " + who\n';

const INIT_C = `
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static void put(const char *path, const char *body) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { printf("PUT-FAIL %s\\n", path); return; }
    write(fd, body, strlen(body));
    close(fd);
}

// Spawn /bin/micropython with the given argv and return its exit status.
static int run(char *const argv[]) {
    pid_t pid;
    if (posix_spawn(&pid, "/bin/micropython", NULL, NULL, argv, NULL) != 0) {
        printf("SPAWN-FAIL\\n");
        return -1;
    }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

int main(void) {
    put("/root/hello.py", ${JSON.stringify(HELLO_PY)});
    put("/root/mymod.py", ${JSON.stringify(MYMOD_PY)});
    chdir("/root");

    char *a1[] = { "micropython", "/root/hello.py", "alpha", "beta", NULL };
    printf("script_status=%d\\n", run(a1));

    char *a2[] = { "micropython", "/root/bye.py", NULL };
    put("/root/bye.py", "import sys\\nsys.exit(7)\\n");
    printf("exit_status=%d\\n", run(a2));

    char *a3[] = { "micropython", "/root/boom.py", NULL };
    put("/root/boom.py", "print('stdout-first')\\nraise ValueError('boom')\\n");
    printf("raise_status=%d\\n", run(a3));

    char *a4[] = { "micropython", "-c", "print('from-c')", NULL };
    printf("dashc_status=%d\\n", run(a4));

    char *a5[] = { "micropython", "/root/nope.py", NULL };
    printf("missing_status=%d\\n", run(a5));

    // sys.std* are the port's own file objects on fds 0/1/2, so .flush() is a
    // real fsync(2) on a kernel-owned fd that is not a regular file. file.c
    // swallows EINVAL for the three std fds precisely so this cannot raise.
    char *a6[] = { "micropython", "/root/std.py", NULL };
    put("/root/std.py",
        "import sys\\n"
        "sys.stdout.write('via-stdout-write\\\\n')\\n"
        "sys.stdout.flush()\\n"
        "sys.stderr.write('via-stderr-write\\\\n')\\n"
        "print('after-flush')\\n");
    printf("std_status=%d\\n", run(a6));

    printf("done\\n");
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-mpscript-'));
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
  ['/bin/micropython', compileProject('vendor/micropython/bin.json')],
]);

const store = new BLOCK_FS.MemoryByteStore(16 << 20);
const kfs = BLOCK_FS.createV4(store);
kfs.mkdir('/root', 0o755);

// fd 1 and fd 2 are kept APART — the stderr-routing leg is the point.
let out = '';
let err = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => {
    const s = Buffer.from(bytes).toString();
    if (fd === 2) { err += s; } else { out += s; }
  },
  onHalt: (status) => haltResolve(status),
  log: (m) => console.log('  [kernel] ' + m),
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\nstdout:\n' + out + '\nstderr:\n' + err);
  process.exit(1);
}, 180000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', status === 0, String(status));

  const has = (needle) => out.includes(needle);
  check('script ran with argv',
        has("argv=['/root/hello.py', 'alpha', 'beta']"), JSON.stringify(out.slice(0, 300)));
  check('open() write+read round-trip', has('read=round-trip'));
  check('import found /root/mymod.py', has('mod=hi os'));
  check('__file__ is the script path', has('file=/root/hello.py'));
  check('script exited 0', has('script_status=0'));
  check('sys.exit(7) -> status 7', has('exit_status=7'));

  check('uncaught exception -> status 1', has('raise_status=1'));
  check('pre-exception stdout still on fd 1', has('stdout-first'));
  check('traceback on fd 2', /ValueError: boom/.test(err), JSON.stringify(err.slice(0, 300)));
  check('traceback NOT on fd 1', !/ValueError: boom/.test(out));

  check('-c ran the command', has('from-c') && has('dashc_status=0'));
  check('sys.stdout.write + flush() on a kernel tty', has('via-stdout-write') && has('std_status=0'));
  check('after the flush, print() still lands', has('after-flush'));
  check('sys.stderr.write goes to fd 2', /via-stderr-write/.test(err) && !/via-stderr-write/.test(out));
  check('missing script -> status 1', has('missing_status=1'));
  check('missing script reported on fd 2', /nope\.py/.test(err), JSON.stringify(err.slice(0, 300)));
  check('init reached the end', has('done'));
  check('no OFDs survive the halt', kernel._ofds.size === 0, String(kernel._ofds.size));

  if (failures) console.log('---- stdout ----\n' + out + '\n---- stderr ----\n' + err + '\n----');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nMicroPython script e2e: PASS'
                             : `\nMicroPython script e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
