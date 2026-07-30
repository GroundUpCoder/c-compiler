#!/usr/bin/env node
// 0037 + #188: the compiled-Module cache on the spawn path. The kernel
// compiles each binary once (moduleKey — immutable prefix:ino on a RO
// volume, VALIDATED prefix:ino:size:mtime on a writable one) and ships the
// WebAssembly.Module in the spawn message; process workers instantiate it
// instead of re-parsing multi-MB bytes per spawn. A rewritten rw binary
// derives a new key and REPLACES its path's entry, so a stale Module can
// never be hit. ss-flavored modules, engine-rejected bytes, and no-fs
// kernels keep the bytes path.
//
// Part 1 drives the kernel with fake workers (no threads — procSpec is
// inspectable) over a MountFS with a readonly /usr; part 2 runs real C in
// worker_threads to prove the Module structured-clones through workerData
// and executes correctly on both the miss and the hit; part 3 is the #188
// acceptance loop in the real OS — cc -o, run, edit, recompile, rerun.
//
// Run: node tests/kernel/test_module_cache.js
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

const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
function writeBytes(kfs, p, bytes) {
  const fd = kfs.open(p, O_WRONLY | O_CREAT | O_TRUNC, 0o755);
  if (fd === null) throw new Error('open ' + p + ': ' + kfs._lastError);
  let off = 0;
  while (off < bytes.length) {
    const n = kfs.write(fd, bytes.subarray(off), bytes.length - off);
    if (n === null) throw new Error('write ' + p + ': ' + kfs._lastError);
    off += n;
  }
  kfs.close(fd);
}
function readFileBytes(kfs, p) {
  const fd = kfs.open(p, 0, 0);
  if (fd === null) return null;
  const st = kfs.fstat(fd);
  const buf = new Uint8Array(st.size);
  let off = 0;
  while (off < buf.length) {
    const n = kfs.read(fd, buf.subarray(off), buf.length - off);
    if (n === null || n === 0) break;
    off += n;
  }
  kfs.close(fd);
  return buf.subarray(0, off);
}

// ---- wasm fixtures (hand-crafted; no compiler needed for part 1) ----
// A minimal valid C-flavored module (empty) and an ss-flavored one (imports
// module "ss" — runModule dispatches those to runSsModule, which recompiles
// from bytes with importedStringConstants, so the kernel must NOT cache it).
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const SS_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,          // magic + version
  1, 4, 1, 0x60, 0, 0,                   // type: () -> ()
  2, 8, 1, 2, 0x73, 0x73, 1, 0x66, 0, 0, // import "ss" "f" (func 0)
]);
const BAD_WASM = new Uint8Array([1, 2, 3, 4]);

// ---- part 1: fake workers over MountFS with a readonly /usr ----
async function part1() {
  console.log('-- part 1: cache policy over fake workers --');
  const sysStore = new BLOCK_FS.MemoryByteStore(4 << 20);
  const bake = BLOCK_FS.createV4(sysStore, { noDevNodes: true });
  bake.mkdir('/bin', 0o755);
  writeBytes(bake, '/bin/x', EMPTY_WASM);
  writeBytes(bake, '/bin/ssmod', SS_WASM);
  writeBytes(bake, '/bin/bad', BAD_WASM);
  const sys = BLOCK_FS.createV4(sysStore, { readonly: true });
  const root = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(4 << 20));
  const kfs = new BLOCK_FS.MountFS({ '/': root, '/usr': sys });
  kfs.mkdir('/root', 0o755);
  kfs.symlink('/usr/bin', '/bin');
  writeBytes(kfs, '/root/a.out', EMPTY_WASM);

  const workers = new Map(); // pid -> handle with .procSpec
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: (procSpec) => {
      const h = {
        procSpec,
        postMessage() {},
        onMessage() {},
        onExit() {},
        terminate() {},
      };
      workers.set(procSpec.pid, h);
      return h;
    },
    loadImage: (p) => readFileBytes(kfs, p),
    log: () => {},
  });

  // Miss, then hits — including via the /bin symlink alias (same inode).
  const pid1 = await kernel.boot({ path: '/usr/bin/x', argv: ['x'] });
  const s1 = workers.get(pid1).procSpec;
  check('RO binary ships a Module', s1.module instanceof WebAssembly.Module);
  check('RO binary ships no bytes', s1.image === null);
  let st = kernel.moduleCacheStats();
  check('first spawn is a miss', st.misses === 1 && st.hits === 0, JSON.stringify(st));

  const pid2 = await kernel.service({ path: '/bin/x', argv: ['x'] });
  const s2 = workers.get(pid2).procSpec;
  check('symlink alias hits the same entry', s2.module === s1.module);
  st = kernel.moduleCacheStats();
  check('alias spawn is a hit', st.hits === 1 && st.misses === 1 && st.entries === 1,
    JSON.stringify(st));

  // Mutable (rw-volume) binary (#188): a VALIDATED key — it rides the cache
  // like an RO binary; a rewrite derives a new key, REPLACES the path's
  // entry, and ships a Module compiled from the NEW bytes, never the stale
  // one.
  const pid3 = await kernel.service({ path: '/root/a.out', argv: ['a.out'] });
  const s3 = workers.get(pid3).procSpec;
  check('rw binary ships a Module, no bytes (#188)',
    s3.module instanceof WebAssembly.Module && s3.image === null);
  st = kernel.moduleCacheStats();
  check('rw binary enters the cache (own entry, one miss)',
    st.misses === 2 && st.entries === 2, JSON.stringify(st));
  const pid3b = await kernel.service({ path: '/root/a.out', argv: ['a.out'] });
  const s3b = workers.get(pid3b).procSpec;
  check('unchanged rw binary is a warm hit (same Module)', s3b.module === s3.module);
  st = kernel.moduleCacheStats();
  check('warm rw spawn counts a hit, adds no entry',
    st.hits === 2 && st.misses === 2 && st.entries === 2, JSON.stringify(st));
  const V2 = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 4, 1, 0x61, 0, 0]); // custom section "a"
  writeBytes(kfs, '/root/a.out', V2);
  const pid4 = await kernel.service({ path: '/root/a.out', argv: ['a.out'] });
  const s4 = workers.get(pid4).procSpec;
  check('rebuilt rw binary ships a NEW Module, never the stale one',
    s4.module instanceof WebAssembly.Module && s4.module !== s3.module);
  check('the new Module is compiled from the NEW bytes',
    s4.module !== null && WebAssembly.Module.customSections(s4.module, 'a').length === 1);
  st = kernel.moduleCacheStats();
  check('rewrite REPLACES the entry (no leak per recompile)',
    st.entries === 2 && st.misses === 3, JSON.stringify(st));

  // ss flavor: compiles kernel-side but is excluded (bytes path), and the
  // exclusion is itself cached (no re-probe per spawn).
  const pid5 = await kernel.service({ path: '/bin/ssmod', argv: ['ssmod'] });
  const s5 = workers.get(pid5).procSpec;
  check('ss module ships bytes, no Module', s5.module === null && s5.image !== null);
  const pid6 = await kernel.service({ path: '/bin/ssmod', argv: ['ssmod'] });
  const s6 = workers.get(pid6).procSpec;
  check('ss exclusion is cached (hit resolving null)', s6.module === null && s6.image !== null);
  st = kernel.moduleCacheStats();
  check('ss pair adds one miss then one cached-null hit',
    st.misses === 4 && st.hits === 3 && st.entries === 3, JSON.stringify(st));

  // Engine-rejected bytes: spawn still ships them (the worker owns the error).
  const pid7 = await kernel.service({ path: '/bin/bad', argv: ['bad'] });
  const s7 = workers.get(pid7).procSpec;
  check('uncompilable RO binary falls back to bytes', s7.module === null && s7.image !== null);

  // No-fs kernel (standalone/test arrangement): the cache is dormant.
  const workers2 = new Map();
  const kernel2 = new K.Kernel({
    createWorker: (procSpec) => {
      const h = { procSpec, postMessage() {}, onMessage() {}, onExit() {}, terminate() {} };
      workers2.set(procSpec.pid, h);
      return h;
    },
    loadImage: (p) => (p === '/bin/y' ? EMPTY_WASM : null),
    log: () => {},
  });
  const pidY = await kernel2.boot({ path: '/bin/y', argv: ['y'] });
  const sy = workers2.get(pidY).procSpec;
  check('no-fs kernel ships bytes as before', sy.module === null && sy.image === EMPTY_WASM);
  check('no-fs kernel counts nothing', kernel2.moduleCacheStats().misses === 0);
}

// ---- part 2: real C through worker_threads (the Module really clones) ----
const INIT_C = `
#include <stdio.h>
#include <spawn.h>
#include <sys/wait.h>
int main(void) {
    for (int i = 0; i < 2; i++) {
        char *argv[] = { "hello", 0 };
        pid_t pid;
        int e = posix_spawn(&pid, "/bin/hello", 0, 0, argv, 0);
        if (e) { printf("spawn failed %d\\n", e); return 1; }
        int st = 0;
        waitpid(pid, &st, 0);
        printf("code=%d\\n", WEXITSTATUS(st));
    }
    return 42;
}
`;
const HELLO_C = `
#include <stdio.h>
int main(void) { printf("hi\\n"); return 5; }
`;

async function part2() {
  console.log('-- part 2: real C, Module cloned through worker_threads --');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-modcache-'));
  function compile(name, src) {
    const c = path.join(tmp, name + '.c');
    const wasm = path.join(tmp, name + '.wasm');
    fs.writeFileSync(c, src);
    cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
    return fs.readFileSync(wasm);
  }

  // Both binaries live on the READONLY /usr volume, reached via /bin ->
  // /usr/bin — the reference-OS layout, so init AND hello ride the cache.
  const sysStore = new BLOCK_FS.MemoryByteStore(16 << 20);
  const bake = BLOCK_FS.createV4(sysStore, { noDevNodes: true });
  bake.mkdir('/bin', 0o755);
  writeBytes(bake, '/bin/init', new Uint8Array(compile('init', INIT_C)));
  writeBytes(bake, '/bin/hello', new Uint8Array(compile('hello', HELLO_C)));
  const sys = BLOCK_FS.createV4(sysStore, { readonly: true });
  const root = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(4 << 20));
  const kfs = new BLOCK_FS.MountFS({ '/': root, '/usr': sys });
  kfs.symlink('/usr/bin', '/bin');

  let out = '';
  let haltResolve;
  const haltPromise = new Promise((r) => { haltResolve = r; });
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => readFileBytes(kfs, p),
    onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
    onHalt: (status) => haltResolve(status),
    log: (m) => console.log('  [kernel] ' + m),
  });

  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;

  check('init exited 42', ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  check('hello ran twice, exit code intact', out === 'hi\ncode=5\nhi\ncode=5\n', JSON.stringify(out));
  const st = kernel.moduleCacheStats();
  check('two entries (init + hello), one hit (the second hello)',
    st.entries === 2 && st.misses === 2 && st.hits === 1, JSON.stringify(st));
}

// ---- part 3: the #188 acceptance loop in the real OS — cc -o a.out &&
// ./a.out, edit, recompile, rerun. The rebuilt binary MUST show the new
// behaviour: now that rw binaries ride the cache, a validation bug here
// would surface as the stale first-generation output after the rebuild. The
// first binary also runs twice, so the warm-hit path is exercised on the
// real spawn chain before the rewrite.
//
// "gen-one" and "gen-two" are the same length ON PURPOSE: the two builds'
// wasm images can come out byte-count-identical, so the validated key's
// size term is degenerate here and the rewrite is caught by the mtime term
// alone — the sharpest form of the guard (compiles take well over the
// store's ms timestamp resolution).
const { driveBoot } = require('./lib/drive.js');
function part3() {
  console.log('-- part 3: in-OS recompile (cc -o; run; edit; recompile; rerun) --');
  const r = driveBoot([
    'cd /root',
    "cat > t.c <<'EOF'",
    '#include <stdio.h>',
    'int main(void) { printf("gen-one\\n"); return 0; }',
    'EOF',
    'cc -o t t.c && ./t',
    './t',
    "cat > t.c <<'EOF'",
    '#include <stdio.h>',
    'int main(void) { printf("gen-two\\n"); return 0; }',
    'EOF',
    'cc -o t t.c && ./t',
  ]);
  const out = String(r.stdout || '');
  const i1 = out.indexOf('gen-one');
  const i2 = i1 < 0 ? -1 : out.indexOf('gen-one', i1 + 1);
  const i3 = out.indexOf('gen-two');
  check('first build runs, cold then warm', i1 >= 0 && i2 > i1, JSON.stringify(out));
  check('rebuilt binary shows the NEW behaviour', i3 > i2, JSON.stringify(out));
  check('no stale gen-one after the rebuild', i3 >= 0 && out.indexOf('gen-one', i3) === -1);
}

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — module-cache test did not finish in 240s');
  process.exit(1);
}, 240000);

(async () => {
  await part1();
  await part2();
  part3();
  clearTimeout(watchdog);
  console.log(failures ? '\nmodule cache: FAIL (' + failures + ')' : '\nmodule cache: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
