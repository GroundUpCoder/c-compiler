#!/usr/bin/env node
// 0009 benchmark gate: the same C workload through the brokered fs (kernel
// RPCs) vs the standalone in-process BlockFS, so the amendment's latency
// price is measured, not assumed. Manual tool — not part of run.js.
//
// The read-only-volume leg (todos/0180): the same READ workload against a
// sealed /usr file, brokered vs served process-locally off the shipped SAB
// (Kernel opts.roImage) — the fast path's payoff, measured.
//
//   node tests/kernel/bench_fs.js
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

const BENCH_C = `
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <sys/stat.h>
static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
int main(void) {
    enum { CHUNK = 8192 };
    static char buf[CHUNK];
    memset(buf, 'x', CHUNK);
    const int MBYTES = 8, n = MBYTES * 1024 * 1024 / CHUNK;

    double t0 = now();
    int fd = open("/bench.dat", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    for (int i = 0; i < n; i++) write(fd, buf, CHUNK);
    close(fd);
    double t1 = now();

    fd = open("/bench.dat", O_RDONLY, 0);
    while (read(fd, buf, CHUNK) > 0) {}
    close(fd);
    double t2 = now();

    struct stat sb;
    const int iters = 2000;
    for (int i = 0; i < iters; i++) {
        int f2 = open("/meta.dat", O_WRONLY | O_CREAT, 0644);
        write(f2, "y", 1);
        close(f2);
        stat("/meta.dat", &sb);
    }
    double t3 = now();

    printf("write(8K) %.1f MB/s | read(8K) %.1f MB/s | metadata %.0f ops/s\\n",
        MBYTES / (t1 - t0), MBYTES / (t2 - t1), iters * 4.0 / (t3 - t2));
    return 0;
}
`;

// The SPSC pipe leg (todos/0181): a writer|reader pipeline moves 16 MB;
// the reader times first-byte -> EOF (spawn/compile overhead excluded).
// "fast" lets the parent close both ends (promotion -> ring transport);
// "brokered" parks a second holder on the READ end (the parent keeps its
// rfd) so the pipe never promotes — same program, RPC transport.
const PIPE_BENCH_C = `
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <spawn.h>
#include <time.h>
#include <sys/wait.h>
static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
enum { CHUNK = 65536 };
static unsigned char buf[CHUNK];
int main(int argc, char **argv) {
    const char *role = argc > 1 ? argv[1] : "";
    const long MB = 16;
    if (!strcmp(role, "pipew")) {
        usleep(300000);                     /* let the promotion land first */
        memset(buf, 0xA5, CHUNK);
        long left = MB * 1024 * 1024;
        while (left > 0) {
            int n = write(1, buf, left < CHUNK ? (int)left : CHUNK);
            if (n <= 0) return 1;
            left -= n;
        }
        return 0;
    }
    if (!strcmp(role, "piper")) {
        long total = 0; int n;
        double t0 = 0;
        while ((n = read(0, buf, CHUNK)) > 0) {
            if (total == 0) t0 = now();
            total += n;
        }
        double t1 = now();
        printf("pipe %.1f MB/s (%ld bytes)\\n",
            total / (1024.0 * 1024.0) / (t1 - t0), total);
        fflush(stdout);
        return 0;
    }
    /* parent: MODE=fast closes both ends (SPSC promotion); MODE=brokered
       keeps the read end so a second holder pins the pipe brokered. */
    int fast = !strcmp(getenv("MODE") ? getenv("MODE") : "fast", "fast");
    int p[2], st; pid_t w, r;
    if (pipe(p)) return 1;
    posix_spawn_file_actions_t fa;
    char *wargv[] = { "bench", "pipew", 0 };
    char *rargv[] = { "bench", "piper", 0 };
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[1], 1);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    if (posix_spawn(&w, "/bin/bench", &fa, 0, (char *const *)wargv, 0)) return 2;
    posix_spawn_file_actions_destroy(&fa);
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, p[0], 0);
    posix_spawn_file_actions_addclose(&fa, p[0]);
    posix_spawn_file_actions_addclose(&fa, p[1]);
    if (posix_spawn(&r, "/bin/bench", &fa, 0, (char *const *)rargv, 0)) return 3;
    posix_spawn_file_actions_destroy(&fa);
    close(p[1]);
    if (fast) close(p[0]);
    waitpid(w, &st, 0);
    waitpid(r, &st, 0);
    if (!fast) close(p[0]);
    return 0;
}
`;

// The RO leg's workload: pure reads + metadata against a sealed /usr file.
const RO_BENCH_C = `
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <sys/stat.h>
static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
int main(void) {
    enum { CHUNK = 8192 };
    static char buf[CHUNK];
    const int PASSES = 4;
    long total = 0;

    double t0 = now();
    for (int p = 0; p < PASSES; p++) {
        int fd = open("/usr/bench.dat", O_RDONLY, 0);
        long n;
        while ((n = read(fd, buf, CHUNK)) > 0) total += n;
        close(fd);
    }
    double t1 = now();

    struct stat sb;
    const int iters = 4000;
    for (int i = 0; i < iters; i++) {
        stat("/usr/bench.dat", &sb);
        int f2 = open("/usr/bench.dat", O_RDONLY, 0);
        read(f2, buf, 64);
        close(f2);
    }
    double t2 = now();

    printf("read(8K) %.1f MB/s | open+read+stat %.0f ops/s\\n",
        total / (1024.0 * 1024.0) / (t1 - t0), iters * 3.0 / (t2 - t1));
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-bench-'));
const cFile = path.join(tmp, 'bench.c');
const wasmFile = path.join(tmp, 'bench.wasm');
fs.writeFileSync(cFile, BENCH_C);
cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });
const image = fs.readFileSync(wasmFile);
const roCFile = path.join(tmp, 'robench.c');
const roWasmFile = path.join(tmp, 'robench.wasm');
fs.writeFileSync(roCFile, RO_BENCH_C);
cp.execFileSync('node', [COMPILER, roCFile, '-o', roWasmFile], { stdio: 'pipe' });
const roImage = fs.readFileSync(roWasmFile);
const pipeCFile = path.join(tmp, 'pipebench.c');
const pipeWasmFile = path.join(tmp, 'pipebench.wasm');
fs.writeFileSync(pipeCFile, PIPE_BENCH_C);
cp.execFileSync('node', [COMPILER, pipeCFile, '-o', pipeWasmFile], { stdio: 'pipe' });
const pipeImage = fs.readFileSync(pipeWasmFile);

// The pipe leg (todos/0181): same pipeline, ring vs pinned-brokered.
function runPipeOnce(fast) {
  return new Promise((resolve, reject) => {
    let out = '';
    const kernel = new K.Kernel({
      fs: BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(4 << 20)),
      createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
      loadImage: (p) => (p === '/bin/bench' ? pipeImage : null),
      onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
      onHalt: () => resolve(out.trim()),
      log: () => {},
    });
    kernel.boot({ path: '/bin/bench', argv: ['bench'],
      envp: ['MODE=' + (fast ? 'fast' : 'brokered')], cwd: '/' }).catch(reject);
    setTimeout(() => reject(new Error('pipe bench timeout\n' + out)), 120000);
  });
}

function runOnce(brokered) {
  return new Promise((resolve, reject) => {
    let out = '';
    const opts = {
      createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
      loadImage: (p) => (p === '/bin/bench' ? image : null),
      onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
      onHalt: () => resolve(out.trim()),
      log: () => {},
    };
    if (brokered) opts.fs = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(32 << 20));
    const kernel = new K.Kernel(opts);
    kernel.boot({ path: '/bin/bench', argv: ['bench'], envp: [], cwd: '/' }).catch(reject);
    setTimeout(() => reject(new Error('bench timeout\n' + out)), 120000);
  });
}

// The RO leg (todos/0180): a two-volume world with an 8MB file baked into
// the sealed /usr volume, run with and without opts.roImage.
function runRoOnce(local) {
  return new Promise((resolve, reject) => {
    const sysStore = new BLOCK_FS.MemoryByteStore(16 << 20);
    const scratch = BLOCK_FS.createV4(sysStore);
    const chunk = new Uint8Array(1 << 16).fill(120);
    const bfd = scratch.open('/bench.dat', 0x40 | 1, 0o644);
    for (let i = 0; i < 128; i++) scratch.write(bfd, chunk, chunk.length);   // 8MB
    scratch.close(bfd);
    const sysFs = BLOCK_FS.createV4(sysStore, { readonly: true });
    const rootFs = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20));
    const kfs = new BLOCK_FS.MountFS({ '/': rootFs, '/usr': sysFs });
    let out = '';
    const opts = {
      fs: kfs,
      createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
      loadImage: (p) => (p === '/bin/bench' ? roImage : null),
      onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
      onHalt: () => resolve(out.trim()),
      log: () => {},
    };
    if (local) opts.roImage = { prefix: '/usr', sab: BLOCK_FS.storeToSab(sysStore) };
    const kernel = new K.Kernel(opts);
    kernel.boot({ path: '/bin/bench', argv: ['bench'], envp: [], cwd: '/' }).catch(reject);
    setTimeout(() => reject(new Error('ro bench timeout\n' + out)), 120000);
  });
}

(async () => {
  const brokered = await runOnce(true);
  const inproc = await runOnce(false);
  console.log('brokered (kernel RPC): ' + brokered);
  console.log('in-process (private) : ' + inproc);
  const roBrokered = await runRoOnce(false);
  const roLocal = await runRoOnce(true);
  console.log('/usr brokered (RPC)  : ' + roBrokered);
  console.log('/usr local (0180 SAB): ' + roLocal);
  const pipeBrokered = await runPipeOnce(false);
  const pipeFast = await runPipeOnce(true);
  console.log('pipe brokered (RPC)  : ' + pipeBrokered);
  console.log('pipe SPSC (0181 ring): ' + pipeFast);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
