// v3 -> v4 migration test. Synthesizes a varied v3 image, migrates it forward,
// and verifies the v4 image matches the v3 source faithfully (content + mode +
// mtime + structure + symlink + hardlink, across >64 inodes). Also asserts the
// migration is NON-DESTRUCTIVE (the v3 store is byte-for-byte unchanged) and
// that the completion marker is set.

'use strict';
const fs = require('fs');
const path = require('path');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();
const { create, createV4, migrateV3toV4, isMigrationComplete, MemoryByteStore } = BLOCK_FS;
const { fsck: fsckV4 } = require('./fsck_v4.js');

const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200, S_IFDIR = 0o040000;
let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('FAIL:', m); } }
function eq(a, b, m) { ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function wfile(bfs, p, str, mode) {
  const fd = bfs.open(p, O_CREAT | O_TRUNC | O_WRONLY, mode || 0o644);
  const b = Buffer.from(str, 'binary');
  if (b.length) bfs.write(fd, b, b.length);
  bfs.close(fd);
}
function rfile(bfs, p) {
  const fd = bfs.open(p, O_RDONLY, 0);
  if (typeof fd !== 'number' || fd < 0) return null;
  const size = bfs.stat(p).size;
  const buf = new Uint8Array(size);
  const n = size ? bfs.read(fd, buf, size) : 0;
  bfs.close(fd);
  return Buffer.from(buf.slice(0, n)).toString('binary');
}

// ---- Build a varied v3 image ----
const v3store = new MemoryByteStore(1 << 20);
const v3 = create(v3store);
const paths = [];
function mkfile(p, content, mode, mtime) {
  wfile(v3, p, content, mode); v3.chmod(p, mode); v3.utime(p, mtime, mtime); paths.push(p);
}
v3.mkdir('/docs', 0o755); paths.push('/docs');
v3.mkdir('/docs/sub', 0o700); paths.push('/docs/sub');
v3.mkdir('/empty', 0o755); paths.push('/empty');
v3.mkdir('/many', 0o755); paths.push('/many');
mkfile('/readme.txt', 'top level readme', 0o644, 1700000001);
mkfile('/docs/a.txt', 'A'.repeat(10), 0o600, 1700000002);
mkfile('/docs/sub/deep.bin', 'X'.repeat(40000), 0o644, 1700000003); // multi-extent
mkfile('/zero.txt', '', 0o666, 1700000004);                          // empty file
mkfile('/exec.sh', '#!/bin/sh\necho hi\n', 0o755, 1700000005);
for (let i = 0; i < 75; i++) mkfile(`/many/f${i}`, `payload-${i}`, 0o644, 1700001000 + i);
v3.symlink('/docs/a.txt', '/link-to-a'); paths.push('/link-to-a');
v3.link('/readme.txt', '/readme-hardlink.txt'); paths.push('/readme-hardlink.txt');

// ---- Capture v3's ACTUAL state (source of truth for fidelity), then snapshot ----
const expect = {};
for (const p of paths) {
  const st = v3.stat(p);
  const isDir = (st.mode & 0o170000) === S_IFDIR;
  expect[p] = { isDir, mode: st.mode & 0o7777, mtime: st.mtime, ino: st.ino,
                content: isDir ? null : rfile(v3, p) };
}
const before = Buffer.from(v3store.getBytes(0, v3store.size()));

// ---- Migrate ----
const v4store = new MemoryByteStore(1 << 16); // small -> forces v4 pool/table growth
migrateV3toV4(v3store, v4store);
ok(isMigrationComplete(v4store), 'completion marker is set');

const after = Buffer.from(v3store.getBytes(0, v3store.size()));
ok(before.equals(after), 'v3 store is byte-for-byte unchanged (non-destructive)');

// the migrated image is structurally sound per the INDEPENDENT v4 checker
{ const p = fsckV4(v4store); ok(p.length === 0, 'migrated v4 image is fsck-clean: ' + p.join('; ')); }

// ---- Verify v4 via a FRESH mount (also proves persistence) ----
const v4 = createV4(v4store);
eq(v4store.getUint32(4), 4, 'v4 superblock version');

let contentOk = true, modeOk = true, mtimeOk = true, typeOk = true;
for (const p of paths) {
  const e = expect[p], st = v4.stat(p);
  const isDir = (st.mode & 0o170000) === S_IFDIR;
  if (isDir !== e.isDir) { typeOk = false; console.error('type mismatch', p); }
  if ((st.mode & 0o7777) !== e.mode) { modeOk = false; console.error('mode', p, (st.mode & 0o7777).toString(8), e.mode.toString(8)); }
  if (st.mtime !== e.mtime) { mtimeOk = false; console.error('mtime', p, st.mtime, e.mtime); }
  if (!e.isDir && rfile(v4, p) !== e.content) { contentOk = false; console.error('content', p); }
}
ok(typeOk, 'file/dir types preserved');
ok(modeOk, 'all modes preserved (match v3 source)');
ok(mtimeOk, 'all mtimes preserved (seconds)');
ok(contentOk, 'all file contents preserved byte-for-byte');

// spot checks
eq(rfile(v4, '/docs/sub/deep.bin'), 'X'.repeat(40000), 'multi-extent file intact');
eq(rfile(v4, '/zero.txt'), '', 'empty file intact');
eq(rfile(v4, '/many/f74'), 'payload-74', 'grown-table file intact');

// symlink target preserved (stored as a regular file whose content is the target)
{
  const buf = new Uint8Array(256);
  const n = v4.readlink('/link-to-a', buf, 256);
  eq(Buffer.from(buf.slice(0, n)).toString(), '/docs/a.txt', 'symlink target preserved');
}

// hardlink: both names share one inode, nlink >= 2, same content
{
  const a = v4.stat('/readme.txt'), b = v4.stat('/readme-hardlink.txt');
  eq(a.ino, b.ino, 'hardlink shares the same inode');
  ok(a.nlink >= 2, `hardlinked inode nlink >= 2 (got ${a.nlink})`);
  eq(rfile(v4, '/readme-hardlink.txt'), 'top level readme', 'hardlink content matches');
}

// ---- Read-only legacy view (the toggle): mount v3 read-only ----
{
  const ro = BLOCK_FS.create(new BLOCK_FS.ReadOnlyStore(v3store));
  ro._readonly = true; // suppress relatime atime writes (would hit the RO store)
  eq(rfile(ro, '/readme.txt'), 'top level readme', 'read-only v3 view reads files');
  eq(rfile(ro, '/many/f10'), 'payload-10', 'read-only v3 view reads grown-table files');
  // Clean refusal (todos/0040): _readonly makes the op itself return EROFS
  // (the ReadOnlyStore wrap stays as the throw-on-write backstop).
  const wfd = ro.open('/should-fail.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  ok(wfd === null && ro._lastError === 'EROFS', 'read-only v3 view rejects writes (EROFS)');
}

console.log(`\nmigrate: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
