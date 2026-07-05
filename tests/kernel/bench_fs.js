#!/usr/bin/env node
// 0009 benchmark gate: the same C workload through the brokered fs (kernel
// RPCs) vs the standalone in-process BlockFS, so the amendment's latency
// price is measured, not assumed. Manual tool — not part of run.js.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-bench-'));
const cFile = path.join(tmp, 'bench.c');
const wasmFile = path.join(tmp, 'bench.wasm');
fs.writeFileSync(cFile, BENCH_C);
cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });
const image = fs.readFileSync(wasmFile);

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

(async () => {
  const brokered = await runOnce(true);
  const inproc = await runOnce(false);
  console.log('brokered (kernel RPC): ' + brokered);
  console.log('in-process (private) : ' + inproc);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
