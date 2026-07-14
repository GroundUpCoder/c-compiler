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
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
