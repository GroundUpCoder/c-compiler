#!/usr/bin/env node
// Process-side read-only /usr end-to-end (todos/0180): REAL C programs
// compiled by compiler.js run as worker_threads under a kernel whose
// embedder ships the sealed system volume as an SAB (Kernel opts.roImage).
// Two boots, the vdso-e2e RPC-op-counter pattern:
//
//   Boot 1 (the acceptance): a program that opens/reads/seeks/stats/lists
//   files under /usr makes ZERO filesystem RPCs — every byte comes off the
//   process-local volume.
//
//   Boot 2 (mixed workload identity): direct /usr writes fail EROFS after
//   the walk, /usr/local escapes to the rw volume (write + read-back via
//   BOTH names), unlink under /usr is EROFS, and a posix_spawn DUP2
//   file-action naming a locally-opened /usr fd feeds the child's stdin
//   (the wrapSpawnHooks promotion — the hush `cmd < /usr/...` class).
//
// Run: node tests/kernel/test_rofs_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- the C programs ---- */
const READER_C = `
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>

int main(void) {
    /* open/read/lseek/fstat/close under /usr */
    int fd = open("/usr/share/data.txt", O_RDONLY);
    if (fd < 0) { printf("OPEN=fail\\n"); return 1; }
    char buf[128];
    int n = read(fd, buf, sizeof buf - 1);
    buf[n < 0 ? 0 : n] = 0;
    printf("READ=%d:%s", n, buf);
    struct stat st;
    fstat(fd, &st);
    printf("FSTAT=%d\\n", (int)st.st_size);
    lseek(fd, 6, SEEK_SET);
    n = read(fd, buf, 5); buf[n < 0 ? 0 : n] = 0;
    printf("SEEKREAD=%s\\n", buf);
    close(fd);

    stat("/usr/share/data.txt", &st);
    printf("STAT=%d\\n", (int)st.st_size);
    printf("ACCESS=%d\\n", access("/usr/share/data.txt", R_OK));

    DIR *d = opendir("/usr/share");
    int ents = 0;
    struct dirent *e;
    while ((e = readdir(d)) != 0) ents++;
    closedir(d);
    printf("ENTS=%d\\n", ents);
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const MIXED_C = `
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "child") == 0) {
        /* stdin arrives via a promoted DUP2 file-action on a /usr fd */
        char buf[64];
        int n = read(0, buf, sizeof buf - 1);
        buf[n < 0 ? 0 : n] = 0;
        printf("CHILD=%s", buf);
        fflush(stdout);
        return 0;
    }

    /* direct /usr write: EROFS after the walk */
    errno = 0;
    int fd = open("/usr/share/data.txt", O_WRONLY);
    printf("WR=%d,%s\\n", fd, errno == EROFS ? "EROFS" : "other");
    errno = 0;
    printf("UNLINK=%d,%s\\n", unlink("/usr/share/data.txt"),
           errno == EROFS ? "EROFS" : "other");

    /* /usr/local escapes to the rw volume */
    fd = open("/usr/local/note.txt", O_CREAT | O_WRONLY, 0644);
    if (fd >= 0) { write(fd, "escaped\\n", 8); close(fd); }
    char buf[64];
    fd = open("/usr/local/note.txt", O_RDONLY);
    int n = fd >= 0 ? read(fd, buf, sizeof buf - 1) : -1;
    if (n >= 0) buf[n] = 0; else buf[0] = 0;
    if (fd >= 0) close(fd);
    printf("VIAUSR=%s", buf);
    fd = open("/var/local/note.txt", O_RDONLY);
    n = fd >= 0 ? read(fd, buf, sizeof buf - 1) : -1;
    if (n >= 0) buf[n] = 0; else buf[0] = 0;
    if (fd >= 0) close(fd);
    printf("VIAVAR=%s", buf);

    /* the promotion: a locally-opened /usr fd as the child's stdin */
    fd = open("/usr/share/data.txt", O_RDONLY);
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, fd, 0);
    char *cargv[] = { "app", "child", 0 };
    pid_t pid; int st;
    int e = posix_spawn(&pid, "/bin/app", &fa, 0, cargv, 0);
    printf("SPAWN=%d\\n", e);
    if (e == 0) waitpid(pid, &st, 0);
    close(fd);
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

/* ---- compile both ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rofs-e2e-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const w = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), c, '-o', w], { stdio: 'pipe' });
  return fs.readFileSync(w);
}
const readerImage = compile('reader', READER_C);
const mixedImage = compile('mixed', MIXED_C);

/* ---- the two-volume world: rw root + sealed /usr shipped as an SAB ---- */
function makeWorld() {
  const sysStore = new BLOCK_FS.MemoryByteStore(1 << 20);
  const scratch = BLOCK_FS.createV4(sysStore);
  scratch.mkdir('/share', 0o755);
  const fd = scratch.open('/share/data.txt', 0x40 | 1, 0o644);
  const text = new TextEncoder().encode('hello sealed world\n');
  scratch.write(fd, text, text.length);
  scratch.close(fd);
  scratch.symlink('/var/local', '/local');   // the 0040 escape

  const rootStore = new BLOCK_FS.MemoryByteStore(1 << 20);
  const rootFs = BLOCK_FS.createV4(rootStore);
  rootFs.mkdir('/var', 0o755);
  rootFs.mkdir('/var/local', 0o755);

  const sysFs = BLOCK_FS.createV4(sysStore, { readonly: true });
  const kfs = new BLOCK_FS.MountFS({ '/': rootFs, '/usr': sysFs });
  return { kfs: kfs, sab: BLOCK_FS.storeToSab(sysStore) };
}

function boot(image, argv) {
  const world = makeWorld();
  let out = '';
  const kernel = new K.Kernel({
    fs: world.kfs,
    roImage: { prefix: '/usr', sab: world.sab },
    createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
    loadImage: (p) => (p === '/bin/app' ? image : null),
    onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
    onHalt: () => {},
    log: () => {},
  });
  kernel.createTty({ cols: 80, rows: 24, output: () => {} });
  const rpcOps = [];
  const origDispatch = kernel._dispatchRpc;
  kernel._dispatchRpc = function (pcb) {
    rpcOps.push(Atomics.load(pcb.i32, K.KP_RPC_OP));
    return origDispatch.call(this, pcb);
  };
  const getOut = () => out;
  const waitOut = (needle, ms) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (out.includes(needle)) return resolve();
      if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
      setTimeout(poll, 10);
    })();
  });
  return kernel.boot({ path: '/bin/app', argv: argv, envp: [], cwd: '/' })
    .then(() => ({ waitOut, getOut, rpcOps }));
}

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — rofs e2e did not finish in 90s');
  process.exit(1);
}, 90000);

(async () => {
  /* ---- boot 1: the zero-RPC acceptance ---- */
  {
    const r = await boot(readerImage, ['app']);
    await r.waitOut('DONE');
    const out = r.getOut();
    check('reader: content', out.includes('READ=19:hello sealed world'), out);
    check('reader: fstat/stat size', out.includes('FSTAT=19') && out.includes('STAT=19'), out);
    check('reader: lseek read', out.includes('SEEKREAD=seale'), out);
    check('reader: access ok', out.includes('ACCESS=0'), out);
    check('reader: readdir sees ., .., data.txt', out.includes('ENTS=3'), out);
    const fsOps = [K.OP.FS_OPEN, K.OP.FS_READ, K.OP.FS_CLOSE, K.OP.FS_LSEEK,
                   K.OP.FS_STAT, K.OP.FS_FSTAT, K.OP.FS_ACCESS, K.OP.FS_OPENDIR];
    const hits = r.rpcOps.filter((op) => fsOps.includes(op));
    check('reader: ZERO filesystem RPCs for the /usr traffic', hits.length === 0,
      hits.map((h) => '0x' + h.toString(16)).join(','));
  }

  /* ---- boot 2: mixed workload behaves identically to today ---- */
  {
    const r = await boot(mixedImage, ['app']);
    await r.waitOut('DONE');
    const out = r.getOut();
    check('mixed: direct /usr write is EROFS', out.includes('WR=-1,EROFS'), out);
    check('mixed: unlink under /usr is EROFS', out.includes('UNLINK=-1,EROFS'), out);
    check('mixed: /usr/local write escaped and reads back via /usr/local',
      out.includes('VIAUSR=escaped'), out);
    check('mixed: ...and via /var/local (it landed on the rw volume)',
      out.includes('VIAVAR=escaped'), out);
    check('mixed: spawn with the local-fd DUP2 action succeeded', out.includes('SPAWN=0'), out);
    check('mixed: the child read /usr bytes off its promoted stdin',
      out.includes('CHILD=hello sealed world'), out);
  }

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nrofs e2e: PASS' : `\nrofs e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
