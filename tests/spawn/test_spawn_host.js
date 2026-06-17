// Host-level test for the posix_spawn ABI (Layer A + B): a C program builds a
// __spawn_spec and calls __spawn / __spawn_wait; runModule is driven with fake
// spawnHooks that CAPTURE the decoded spec. Proves the C struct ABI and the
// host-side marshalling (path, argv, envp, cwd, file_actions, flags, pgid) match
// byte-for-byte, the returned pid flows back to C, and the wait status is
// written into the C *status pointer.
//
// Run: node tests/spawn/test_spawn_host.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const COMPILER = path.join(ROOT, 'compiler.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); failures++; }
}

const SRC = `
#include <unistd.h>
#include <stdio.h>
int main(void) {
    struct __fd_action acts[2] = {
        { 0, 1, 5, 0, 0 },              /* DUP2: fd 5 -> 1 */
        { 1, 7, 0, "/log.txt", 0644 },  /* OPEN: /log.txt at fd 7 */
    };
    char *argv[] = { "prog", "arg1", "arg2", 0 };
    char *envp[] = { "A=1", "B=2", 0 };
    struct __spawn_spec spec;
    spec.path = "/bin/prog";
    spec.argv = argv;
    spec.envp = envp;
    spec.cwd = "/work";
    spec.actions = acts;
    spec.n_actions = 2;
    spec.flags = 1;       /* SETPGID */
    spec.pgid = 99;
    int pid = __spawn(&spec);
    int st = 0;
    int w = __spawn_wait(pid, &st, 0);
    printf("pid=%d wait=%d status=%d\\n", pid, w, st);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-host-'));
const cFile = path.join(tmp, 'spawn.c');
const wasmFile = path.join(tmp, 'spawn.wasm');
fs.writeFileSync(cFile, SRC);
cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });

const hostSrc = fs.readFileSync(HOST, 'utf8').replace(/^#![^\n]*\n/, '');
const { runModule, BLOCK_FS } = new Function(
  hostSrc + '\nreturn { runModule: runModule, BLOCK_FS: BLOCK_FS };')();

const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const blockFS = BLOCK_FS.createV4(store);

let captured = null;
let waitArgs = null;
let out = '';

(async () => {
  const exit = await runModule({
    bytes: fs.readFileSync(wasmFile),
    args: ['spawn.wasm'],
    blockFsFactory: async (ctx) => ({ c: blockFS.toWasmEnv(ctx) }),
    writeOut: (b) => { out += Buffer.from(b).toString(); },
    writeErr: (b) => { out += Buffer.from(b).toString(); },
    spawnHooks: {
      spawn: (spec) => { captured = spec; return { pid: 4242 }; },
      wait: (pid, options) => { waitArgs = { pid, options }; return { pid, status: (7 << 8) }; },
      kill: () => ({}),
    },
  });

  check('program exited 0', exit === 0, 'exit=' + exit);
  check('spawn hook saw the spec', !!captured);
  if (captured) {
    check('path', captured.path === '/bin/prog', captured.path);
    check('argv', JSON.stringify(captured.argv) === JSON.stringify(['prog', 'arg1', 'arg2']), JSON.stringify(captured.argv));
    check('envp', JSON.stringify(captured.envp) === JSON.stringify(['A=1', 'B=2']), JSON.stringify(captured.envp));
    check('cwd', captured.cwd === '/work', captured.cwd);
    check('flags', captured.flags === 1, String(captured.flags));
    check('pgid', captured.pgid === 99, String(captured.pgid));
    check('n_actions', captured.actions.length === 2, String(captured.actions.length));
    const a0 = captured.actions[0], a1 = captured.actions[1];
    check('action0 DUP2 fd5->1', a0 && a0.op === 0 && a0.fd === 1 && a0.arg === 5 && a0.path === null,
      JSON.stringify(a0));
    check('action1 OPEN /log.txt fd7 0644', a1 && a1.op === 1 && a1.fd === 7 && a1.path === '/log.txt' && a1.mode === 0o644,
      JSON.stringify(a1));
  }
  check('wait got the returned pid', waitArgs && waitArgs.pid === 4242, JSON.stringify(waitArgs));
  // status (7<<8)=1792 written into the C int; pid=4242 returned.
  check('C saw pid=4242 wait=4242 status=1792', out.trim() === 'pid=4242 wait=4242 status=1792', JSON.stringify(out.trim()));

  console.log(failures === 0 ? '\nspawn-host: PASS' : `\nspawn-host: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
