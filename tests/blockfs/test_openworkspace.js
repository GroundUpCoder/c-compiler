// Tests BLOCK_FS.openWorkspace() — the OPFS-backed v4 mount/migration lifecycle —
// against a fake in-memory OPFS, so the decision flow (mount v4 / migrate-forward
// / fresh / legacy-readonly) and the two-file handle handling are verified without
// a real browser. The migration *correctness* is covered by test_migrate.js.

'use strict';
const fs = require('fs');
const path = require('path');

// ---- Fake OPFS: named files backed by growable Buffers + sync access handles ----
function makeFakeOPFS() {
  const files = new Map(); // name -> { buf: Buffer }
  function handleFor(name) {
    const f = files.get(name);
    return {
      read(u8, opts) {
        const at = (opts && opts.at) || 0;
        const n = Math.max(0, Math.min(u8.length, f.buf.length - at));
        if (n > 0) f.buf.copy(u8, 0, at, at + n);
        for (let i = n; i < u8.length; i++) u8[i] = 0;
        return n;
      },
      write(u8, opts) {
        const at = (opts && opts.at) || 0;
        if (at + u8.length > f.buf.length) { const nb = Buffer.alloc(at + u8.length); f.buf.copy(nb); f.buf = nb; }
        Buffer.from(u8.buffer, u8.byteOffset, u8.length).copy(f.buf, at);
        return u8.length;
      },
      getSize() { return f.buf.length; },
      truncate(n) {
        if (n < f.buf.length) f.buf = f.buf.subarray(0, n);
        else if (n > f.buf.length) { const nb = Buffer.alloc(n); f.buf.copy(nb); f.buf = nb; }
      },
      flush() {}, close() {},
    };
  }
  const dir = {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts || !opts.create) { const e = new Error('NotFound'); e.name = 'NotFoundError'; throw e; }
        files.set(name, { buf: Buffer.alloc(0) });
      }
      return { async createSyncAccessHandle() { return handleFor(name); } };
    },
  };
  return { navigator: { storage: { async getDirectory() { return dir; } } }, files };
}

const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8').replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('FAIL:', m); } }
function eq(a, b, m) { ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
function wfile(bfs, p, s) { const fd = bfs.open(p, O_CREAT | O_TRUNC | O_WRONLY, 0o644); const b = Buffer.from(s); if (b.length) bfs.write(fd, b, b.length); bfs.close(fd); }
function rfile(bfs, p) { const fd = bfs.open(p, O_RDONLY, 0); if (typeof fd !== 'number' || fd < 0) return null; const sz = bfs.stat(p).size; const buf = new Uint8Array(sz); const n = sz ? bfs.read(fd, buf, sz) : 0; bfs.close(fd); return Buffer.from(buf.slice(0, n)).toString(); }

async function run() {
  // ---- 1. Fresh: no images -> a fresh v4 ----
  let env = makeFakeOPFS(); Object.defineProperty(globalThis, "navigator", { value: env.navigator, configurable: true });
  let r = await BLOCK_FS.openWorkspace({});
  eq(r.mode, 'fresh', 'no images -> fresh v4');
  wfile(r.fs, '/a.txt', 'fresh-data');
  ok(env.files.has('workspace.v4.img'), 'fresh creates workspace.v4.img');
  ok(!env.files.has('workspace.img'), 'fresh does not create a v3 image');

  // ---- 2. Seed a legacy v3 image; first boot migrates it forward ----
  env = makeFakeOPFS(); Object.defineProperty(globalThis, "navigator", { value: env.navigator, configurable: true });
  {
    // build a v3 image directly in the fake OPFS via a SyncAccessHandle store shim
    const dir = await env.navigator.storage.getDirectory();
    const h = await (await dir.getFileHandle('workspace.img', { create: true })).createSyncAccessHandle();
    const tmp = new Uint8Array(4); const dv = new DataView(tmp.buffer);
    const store = {
      getUint32: (o) => { h.read(tmp, { at: o }); return dv.getUint32(0, true); },
      setUint32: (o, v) => { dv.setUint32(0, v, true); h.write(tmp, { at: o }); },
      getBytes: (o, l) => { const b = new Uint8Array(l); if (l) h.read(b, { at: o }); return b; },
      setBytes: (o, d) => { if (d.length) h.write(d, { at: o }); },
      size: () => h.getSize(), resize: (n) => h.truncate(n),
    };
    const v3 = BLOCK_FS.create(store);
    v3.mkdir('/docs', 0o755);
    wfile(v3, '/docs/note.txt', 'legacy v3 content');
    wfile(v3, '/big.bin', 'Z'.repeat(20000));
  }
  r = await BLOCK_FS.openWorkspace({});
  eq(r.mode, 'migrated', 'legacy v3 present -> migrated');
  eq(rfile(r.fs, '/docs/note.txt'), 'legacy v3 content', 'migrated file readable in v4');
  eq(rfile(r.fs, '/big.bin'), 'Z'.repeat(20000), 'migrated large file intact');
  ok(BLOCK_FS.isMigrationComplete({
    getUint32: (() => { const dir = env.files.get('workspace.v4.img').buf; return (o) => dir.readUInt32LE(o); })(),
    size: () => env.files.get('workspace.v4.img').buf.length,
  }), 'v4 image marked complete');
  ok(env.files.has('workspace.img'), 'v3 image kept as rollback');

  // ---- 3. Second boot: complete v4 exists -> mount it directly (no re-migrate) ----
  r = await BLOCK_FS.openWorkspace({});
  eq(r.mode, 'v4', 'complete v4 -> mounted directly');
  eq(rfile(r.fs, '/docs/note.txt'), 'legacy v3 content', 'data persists on v4 remount');

  // ---- 4. Toggle: view the legacy v3 image read-only ----
  r = await BLOCK_FS.openWorkspace({ viewLegacy: true });
  eq(r.mode, 'legacy-readonly', 'viewLegacy -> legacy-readonly');
  eq(rfile(r.fs, '/docs/note.txt'), 'legacy v3 content', 'legacy view reads v3 data');
  // Clean refusal (todos/0040): _readonly makes open() itself return EROFS.
  const wfd = r.fs.open('/x.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  ok(wfd === null && r.fs._lastError === 'EROFS', 'legacy view rejects writes');

  // ---- 5. Toggle with no legacy image present ----
  env = makeFakeOPFS(); Object.defineProperty(globalThis, "navigator", { value: env.navigator, configurable: true });
  await BLOCK_FS.openWorkspace({}); // creates a fresh v4 only
  r = await BLOCK_FS.openWorkspace({ viewLegacy: true });
  eq(r.mode, 'no-legacy', 'viewLegacy with no v3 -> no-legacy');

  console.log(`\nopenWorkspace: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
run();
