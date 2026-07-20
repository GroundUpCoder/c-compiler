#!/usr/bin/env node
// 0140 regression: an in-OS read() of a REGULAR FILE fills up to `count` in
// ONE call — matching native/Node fs.readSync — instead of returning a single
// KP_FS_CHUNK-capped chunk. The bug: RemoteFS.read capped every brokered
// FS_READ at KP_FS_CHUNK (60000 B) and returned after one chunk, so a program
// doing one large unlooped read(fd, buf, N>chunk) of a regular file got its
// buffer silently truncated (mGBA's 16 MB ROM loader was the first victim —
// the zero-tailed ROM derailed the emulated CPU to 0x09000000; see
// logs/2026-07-20/mgba-crt0-codegen-fix.md).
//
// This asserts:
//   - a single read() of an N-byte regular file (N > KP_FS_CHUNK) returns N
//     AND every byte matches (FAILS on the pre-fix short read: rv==60000)
//   - a partial read (buffer smaller than the file) fills the whole buffer
//   - the fix is SCOPED to regular files: a pipe read with a large count
//     still SHORT-reads (returns only what's buffered) and does NOT loop /
//     block waiting for a full fill — POSIX pipe semantics preserved
//
// Run: node tests/kernel/test_read_fill_e2e.js
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

const CHUNK = K.KP_FS_CHUNK;         // 60000 — the per-RPC cap the fix loops past
const N = CHUNK * 4 + 12345;         // spans 5 FS_READ chunks (a non-multiple tail)

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The guest program. A deterministic pattern (byte i = (i*31+7) & 0xff) lets
// us prove the WHOLE buffer is correct, not just the length — a fill bug that
// returned N but left the tail zero would still fail the byte check.
const INIT_C = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

#define N ${N}
#define CHUNK ${CHUNK}

static unsigned char pat(long i) { return (unsigned char)((i * 31 + 7) & 0xff); }

int main(void) {
    unsigned char *w = malloc(N);
    for (long i = 0; i < N; i++) w[i] = pat(i);

    /* write the big regular file (write() may short-write; loop it — the bug
       and its fix are on the READ path, so writing must be correct here). */
    int fd = open("/big.dat", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    long off = 0;
    while (off < N) {
        long n = write(fd, w + off, N - off);
        if (n <= 0) { printf("write-fail off=%ld\\n", off); return 1; }
        off += n;
    }
    close(fd);

    /* THE regression: ONE read() of the whole file must return N and match. */
    unsigned char *r = calloc(1, N);
    fd = open("/big.dat", O_RDONLY);
    long rv = read(fd, r, N);
    int match = 1; long badat = -1;
    for (long i = 0; i < N; i++) if (r[i] != pat(i)) { match = 0; badat = i; break; }
    printf("bigread rv=%ld want=%d chunk=%d match=%d badat=%ld\\n",
           rv, N, CHUNK, match, badat);
    close(fd);

    /* a partial read (buffer smaller than the file) fills the whole buffer. */
    long pcount = CHUNK * 2 + 500;
    unsigned char *p = calloc(1, pcount);
    fd = open("/big.dat", O_RDONLY);
    long pv = read(fd, p, pcount);
    int pmatch = 1;
    for (long i = 0; i < pcount; i++) if (p[i] != pat(i)) { pmatch = 0; break; }
    printf("partread rv=%ld want=%ld match=%d\\n", pv, pcount, pmatch);
    close(fd);

    /* SCOPE PROOF: a pipe must keep POSIX short-read semantics — a large read
       returns only the 5 buffered bytes and does NOT loop/block for a fill. */
    int pfd[2];
    if (pipe(pfd) != 0) { printf("pipe-fail\\n"); return 1; }
    write(pfd[1], "hello", 5);
    close(pfd[1]);                       /* EOF so even a (buggy) loop can't hang */
    char pb[4096];
    long sv = read(pfd[0], pb, sizeof pb);
    printf("piperead rv=%ld first=%d\\n", sv, sv > 0 ? pb[0] : -1);
    close(pfd[0]);

    printf("done\\n");
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-readfill-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([['/bin/init', compile('init', INIT_C)]]);

const store = new BLOCK_FS.MemoryByteStore(8 << 20);
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
}, 60000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  check('init exited 0', ((status >> 8) & 0xff) === 0 && (status & 0x7f) === 0, String(status));

  const big = /bigread rv=(\d+) want=(\d+) chunk=(\d+) match=(\d+) badat=(-?\d+)/.exec(out);
  check('one read() of the >chunk regular file returns the FULL count',
    !!big && big[1] === big[2], big ? `rv=${big[1]} want=${big[2]} chunk=${big[3]}` : 'no match');
  check('the whole buffer matches (no zero-tail truncation)',
    !!big && big[4] === '1', big ? `badat=${big[5]}` : 'no match');

  const part = /partread rv=(\d+) want=(\d+) match=(\d+)/.exec(out);
  check('a partial read fills the whole (smaller) buffer',
    !!part && part[1] === part[2] && part[3] === '1',
    part ? `rv=${part[1]} want=${part[2]} match=${part[3]}` : 'no match');

  const pipe = /piperead rv=(\d+) first=(\d+)/.exec(out);
  check('SCOPED: a pipe still short-reads (returns 5, not looped/blocked)',
    !!pipe && pipe[1] === '5' && pipe[2] === '104' /* 'h' */,
    pipe ? `rv=${pipe[1]} first=${pipe[2]}` : 'no match');

  check('guest ran to completion', out.includes('done'), JSON.stringify(out.slice(-120)));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nread-fill e2e: PASS' : `\nread-fill e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
