// Functional tests for the BLOCK_FS v4 format (128-byte inodes, TLSF64, 64-bit
// sizes, ms timestamps). Exercises a fresh v4 image through the BlockFS API:
// file I/O, directories, large files (extent growth), >64 inodes (table growth),
// 64-bit field storage, and re-mount persistence.

'use strict';
const fs = require('fs');
const path = require('path');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();
const { createV4, MemoryByteStore } = BLOCK_FS;

const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('FAIL:', m); } }
function eq(a, b, m) { ok(a === b, `${m} (got ${a}, want ${b})`); }

function writeFile(bfs, p, str) {
  const fd = bfs.open(p, O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  ok(typeof fd === 'number' && fd >= 0, `open(w) ${p} -> ${fd}`);
  const bytes = Buffer.from(str, 'binary');
  const n = bfs.write(fd, bytes, bytes.length);
  eq(n, bytes.length, `write ${p} full length`);
  bfs.close(fd);
}
function readFile(bfs, p) {
  const fd = bfs.open(p, O_RDONLY, 0);
  if (typeof fd !== 'number' || fd < 0) return null;
  const size = bfs.stat(p).size;
  const buf = new Uint8Array(size);
  const n = bfs.read(fd, buf, size);
  bfs.close(fd);
  return Buffer.from(buf.slice(0, n)).toString('binary');
}

// ---- 1. Fresh mount + basic file round-trip ----
let store = new MemoryByteStore(1 << 20);
let bfs = createV4(store);
ok(bfs, 'createV4 mounts a fresh v4 image');
eq(store.getUint32(4), 4, 'superblock version is 4');

writeFile(bfs, '/hello.txt', 'hello v4 world');
eq(readFile(bfs, '/hello.txt'), 'hello v4 world', 'file round-trips');
eq(bfs.stat('/hello.txt').size, 14, 'stat size correct');
ok((bfs.stat('/hello.txt').mode & 0o170000) === 0o100000, 'regular-file mode');

// ---- 2. Directories ----
eq(bfs.mkdir('/dir', 0o755), 0, 'mkdir');
ok((bfs.stat('/dir').mode & 0o170000) === 0o040000, 'directory mode');
writeFile(bfs, '/dir/nested.txt', 'nested');
eq(readFile(bfs, '/dir/nested.txt'), 'nested', 'nested file round-trips');

// ---- 3. Large file forces extent growth + read-back ----
const big = 'A'.repeat(50000); // 50 KB > initial extents
writeFile(bfs, '/big.bin', big);
eq(bfs.stat('/big.bin').size, 50000, 'large file size');
eq(readFile(bfs, '/big.bin'), big, 'large file content intact');

// ---- 4. >64 files forces inode-table growth (INITIAL_INODE_CAPACITY=64) ----
for (let i = 0; i < 80; i++) writeFile(bfs, `/f${i}.txt`, `file-${i}-payload`);
let allOk = true;
for (let i = 0; i < 80; i++) if (readFile(bfs, `/f${i}.txt`) !== `file-${i}-payload`) allOk = false;
ok(allOk, 'all 80 files survive inode-table growth');

// ---- 5. 64-bit fields: ms timestamps stored as >2^32 values ----
const ino = bfs._inodes.read(bfs.stat('/hello.txt').ino);
ok(ino.mtime > 0x100000000, `inode mtime stored as ms (>2^32): ${ino.mtime}`);
const statSec = bfs.stat('/hello.txt').mtime;
ok(statSec > 1700000000 && statSec < 1900000000, `stat() presents seconds: ${statSec}`);
eq(Math.floor(ino.mtime / 1000), statSec, 'ms storage / seconds presentation are consistent');

// ---- 6. ftruncate + 64-bit size field plumbing ----
{
  const fd = bfs.open('/trunc.bin', O_CREAT | O_WRONLY, 0o644);
  bfs.write(fd, Buffer.from('12345'), 5);
  bfs.ftruncate(fd, 3);
  bfs.close(fd);
  eq(bfs.stat('/trunc.bin').size, 3, 'ftruncate shrinks size');
}

// ---- 7. Re-mount: persistence across a fresh v4 mount over the same store ----
bfs = createV4(store); // load existing (magic + version 4)
eq(readFile(bfs, '/hello.txt'), 'hello v4 world', 'file survives re-mount');
eq(readFile(bfs, '/dir/nested.txt'), 'nested', 'nested file survives re-mount');
eq(readFile(bfs, '/big.bin'), big, 'large file survives re-mount');
eq(readFile(bfs, '/f79.txt'), 'file-79-payload', 'grown-table file survives re-mount');

console.log(`\nv4: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
