#!/usr/bin/env node
// SPSC pipe fast path end-to-end (todos/0181): REAL C pipelines in
// worker_threads over the brokered kernel, the rofs-e2e RPC-op-counter
// pattern. Three boots:
//
//   Boot 1 (the acceptance): an 8 MB writer|reader pipeline moves its bytes
//   through the shared ring — data RPCs (FS_READ/FS_WRITE) stay at setup
//   noise (« the ~280 a brokered run needs), wake traffic (FS_WAIT +
//   PIPE_KICK) is counted separately, and the payload arrives intact.
//
//   Boot 2 (`yes | head`): the reader hangs up on a fast writer — PRF_RGONE
//   discovered locally, PIPE_KICK{epipe:1} deals the SIGPIPE, the writer
//   dies WTERMSIG==SIGPIPE exactly like a brokered run.
//
//   Boot 3 (demotion mid-stream): a FAST pipe's writer spawns a child that
//   inherits the write end — the pipe demotes, the remaining 2 MB flows
//   brokered THROUGH THE SAME RING, and the reader's total/checksum can't
//   tell the difference (byte-identical, the 0181 acceptance).
//
// The children settle ~300ms before moving bytes so the parent's post-spawn
// closes (the promotion trigger) land first — not a sync primitive: if the
// settle loses the race under load, the tolerant RPC bounds absorb a few
// early brokered ops and the data assertions are timing-independent.
//
// Run: node tests/kernel/test_spsc_e2e.js
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

const APP_C = `
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>

#define CHUNK 65536
static unsigned char buf[CHUNK];

/* Every payload byte is 0xA5 so checksums are independent of partial-write
   splits and of the fast/brokered interleave order. */
static void fill(void) { memset(buf, 0xA5, CHUNK); }

static long pump_out(long total) {          /* write that many bytes to fd 1 */
    long sent = 0;
    while (sent < total) {
        long left = total - sent;
        int want = left < CHUNK ? (int)left : CHUNK;
        int n = write(1, buf, want);
        if (n <= 0) return sent;
        sent += n;
    }
    return sent;
}

static pid_t run(char *const argv[], posix_spawn_file_actions_t *fa) {
    pid_t pid;
    int e = posix_spawn(&pid, "/bin/app", fa, 0, (char *const *)argv, 0);
    if (e) { printf("SPAWNFAIL=%d\\n", e); exit(99); }
    return pid;
}

int main(int argc, char **argv) {
    const char *role = argc > 1 ? argv[1] : "";
    fill();

    if (!strcmp(role, "writer")) {          /* N MB to fd 1, then exit */
        usleep(300000);                      /* settle: see the header */
        long mb = atoi(argv[2]);
        pump_out(mb * 1024 * 1024);
        return 0;
    }
    if (!strcmp(role, "spam")) {             /* unbounded-ish: dies of SIGPIPE */
        usleep(300000);
        pump_out(64L * 1024 * 1024);
        return 7;                            /* only reached if EPIPE never came */
    }
    if (!strcmp(role, "reader")) {           /* sum fd 0 to EOF */
        usleep(300000);
        unsigned int sum = 0; long total = 0; int n;
        while ((n = read(0, buf, CHUNK)) > 0) {
            for (int i = 0; i < n; i++) sum += buf[i];
            total += n;
        }
        printf("SUM=%u TOTAL=%ld\\n", sum, total);
        fflush(stdout);
        return 0;
    }
    if (!strcmp(role, "head")) {             /* take 128K, hang up */
        usleep(300000);
        long got = 0; int n;
        while (got < 131072 && (n = read(0, buf, CHUNK)) > 0) got += n;
        printf("HEAD=%ld\\n", got);
        fflush(stdout);
        return 0;                            /* close-on-exit = the hangup */
    }
    if (!strcmp(role, "demow")) {            /* 1MB fast, spawn sharer, 1MB brokered */
        usleep(300000);
        pump_out(1024 * 1024);
        char *cargv[] = { "app", "demow2", 0 };
        pid_t c; int st;
        /* full inheritance: the child shares fd 1 -> the kernel demotes */
        int e = posix_spawn(&c, "/bin/app", 0, 0, (char *const *)cargv, 0);
        if (e) return 98;
        waitpid(c, &st, 0);
        pump_out(1024 * 1024);
        return 0;
    }
    if (!strcmp(role, "demow2")) {           /* the second holder: brokered MB */
        pump_out(1024 * 1024);
        return 0;
    }

    /* ---- the parent; phase rides the environment ---- */
    int p[2], st; pid_t w, r;
    const char *which = getenv("PHASE");
    if (!which) which = "xfer";

    if (!strcmp(which, "xfer")) {
        if (pipe(p)) { printf("PIPEFAIL\\n"); return 1; }
        posix_spawn_file_actions_t fa;
        char *wargv[] = { "app", "writer", "8", 0 };
        char *rargv[] = { "app", "reader", 0 };
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[1], 1);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        w = run(wargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[0], 0);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        r = run(rargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        close(p[0]); close(p[1]);
        waitpid(w, &st, 0); printf("WSTAT=%d\\n", st);
        waitpid(r, &st, 0); printf("RSTAT=%d\\n", st);
    } else if (!strcmp(which, "sigpipe")) {
        if (pipe(p)) { printf("PIPEFAIL\\n"); return 1; }
        posix_spawn_file_actions_t fa;
        char *wargv[] = { "app", "spam", 0 };
        char *rargv[] = { "app", "head", 0 };
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[1], 1);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        w = run(wargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[0], 0);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        r = run(rargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        close(p[0]); close(p[1]);
        waitpid(w, &st, 0);
        printf("SIGPIPE=%d\\n", WIFSIGNALED(st) && WTERMSIG(st) == SIGPIPE);
        waitpid(r, &st, 0); printf("RSTAT=%d\\n", st);
    } else {                                  /* demote */
        if (pipe(p)) { printf("PIPEFAIL\\n"); return 1; }
        posix_spawn_file_actions_t fa;
        char *wargv[] = { "app", "demow", 0 };
        char *rargv[] = { "app", "reader", 0 };
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[1], 1);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        w = run(wargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        posix_spawn_file_actions_init(&fa);
        posix_spawn_file_actions_adddup2(&fa, p[0], 0);
        posix_spawn_file_actions_addclose(&fa, p[0]);
        posix_spawn_file_actions_addclose(&fa, p[1]);
        r = run(rargv, &fa);
        posix_spawn_file_actions_destroy(&fa);
        close(p[0]); close(p[1]);
        waitpid(w, &st, 0); printf("WSTAT=%d\\n", st);
        waitpid(r, &st, 0); printf("RSTAT=%d\\n", st);
    }
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

/* ---- compile once ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spsc-e2e-'));
const cFile = path.join(tmp, 'app.c');
const wasmFile = path.join(tmp, 'app.wasm');
fs.writeFileSync(cFile, APP_C);
cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });
const appImage = fs.readFileSync(wasmFile);

function boot(phase) {
  const store = new BLOCK_FS.MemoryByteStore(4 << 20);
  const kfs = BLOCK_FS.createV4(store);
  let out = '';
  let haltResolve;
  const halted = new Promise((res) => { haltResolve = res; });
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => (p === '/bin/app' ? appImage : null),
    onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
    onHalt: (status) => haltResolve(status),
    log: () => {},
  });
  kernel.createTty({ output: () => {} });
  const rpcOps = [];
  const origDispatch = kernel._dispatchRpc;
  kernel._dispatchRpc = function (pcb) {
    rpcOps.push(Atomics.load(pcb.i32, K.KP_RPC_OP));
    return origDispatch.call(this, pcb);
  };
  return kernel.boot({
    path: '/bin/app', argv: ['app'], envp: ['PHASE=' + phase], cwd: '/',
  }).then(() => halted).then((status) => ({
    status, kernel, rpcOps,
    out: () => out,
    count: (op) => rpcOps.filter((o) => o === op).length,
  }));
}

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — spsc e2e did not finish in 120s');
  process.exit(1);
}, 120000);

(async () => {
  /* ---- boot 1: 8 MB through the ring, data RPCs at setup noise ---- */
  {
    const r = await boot('xfer');
    const out = r.out();
    check('xfer: init exited 0', r.status === 0, String(r.status));
    check('xfer: payload intact (sum + total)',
      out.includes('SUM=' + (0xA5 * 8 * 1024 * 1024 >>> 0) + ' TOTAL=' + 8 * 1024 * 1024), out);
    check('xfer: both children exited 0', out.includes('WSTAT=0') && out.includes('RSTAT=0'), out);
    const reads = r.count(K.OP.FS_READ), writes = r.count(K.OP.FS_WRITE);
    const waits = r.count(K.OP.FS_WAIT), kicks = r.count(K.OP.PIPE_KICK);
    console.log(`  [rpc] FS_READ=${reads} FS_WRITE=${writes} FS_WAIT=${waits} PIPE_KICK=${kicks}`);
    // Brokered, 8 MB needs ~140 FS_READ + ~142 FS_WRITE (60000-byte RPC
    // chunks). Steady-state-zero leaves only the result printfs and any
    // settle-race stragglers.
    check('xfer: pipe reads left the kernel (FS_READ ≤ 4)', reads <= 4, String(reads));
    check('xfer: pipe writes left the kernel (FS_WRITE ≤ 8)', writes <= 8, String(writes));
    check('xfer: no OFDs survive the halt', r.kernel._ofds.size === 0, String(r.kernel._ofds.size));
  }

  /* ---- boot 2: `yes | head` — local EPIPE, kicked SIGPIPE death ---- */
  {
    const r = await boot('sigpipe');
    const out = r.out();
    check('sigpipe: init exited 0', r.status === 0, String(r.status));
    check('sigpipe: head took its 128K', out.includes('HEAD=131072'), out);
    check('sigpipe: fast writer died of SIGPIPE', out.includes('SIGPIPE=1'), out);
    const writes = r.count(K.OP.FS_WRITE);
    check('sigpipe: spam writes stayed local (FS_WRITE ≤ 8)', writes <= 8, String(writes));
    check('sigpipe: no OFDs survive the halt', r.kernel._ofds.size === 0, String(r.kernel._ofds.size));
  }

  /* ---- boot 3: mid-stream demotion is invisible to the payload ---- */
  {
    const r = await boot('demote');
    const out = r.out();
    check('demote: init exited 0', r.status === 0, String(r.status));
    check('demote: 3 MB arrived intact across the FAST->DEMOTED flip',
      out.includes('SUM=' + (0xA5 * 3 * 1024 * 1024 >>> 0) + ' TOTAL=' + 3 * 1024 * 1024), out);
    check('demote: writers exited clean', out.includes('WSTAT=0') && out.includes('RSTAT=0'), out);
    const writes = r.count(K.OP.FS_WRITE);
    // 2 MB flowed AFTER the demotion -> ~35 brokered 60000-byte write RPCs.
    // Their presence is the proof the pipe really demoted.
    check('demote: post-demotion traffic really brokered (FS_WRITE ≥ 20)', writes >= 20, String(writes));
    check('demote: no OFDs survive the halt', r.kernel._ofds.size === 0, String(r.kernel._ofds.size));
  }

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nspsc e2e: PASS' : `\nspsc e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
