// Functional tests for /dev character devices on BLOCK_FS v4. Exercises the
// auto-created nodes through the BlockFS API: read/write semantics per device,
// S_IFCHR + rdev in stat, /dev directory listing, and ensureDevNodes idempotency
// + self-heal after unlink.

'use strict';
const fs = require('fs');
const path = require('path');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();
const { createV4, MemoryByteStore } = BLOCK_FS;

const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2;
const S_IFMT = 0o170000, S_IFCHR = 0o020000;
const makedev = (ma, mi) => ((ma & 0xfff) << 8) | (mi & 0xff);

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('FAIL:', m); } }
function eq(a, b, m) { ok(a === b, `${m} (got ${a}, want ${b})`); }

const store = new MemoryByteStore(1 << 20);
const bfs = createV4(store);

// ---- 1. /dev exists and the nodes are auto-created on mount ----
ok(bfs.stat('/dev') && (bfs.stat('/dev').mode & S_IFMT) === 0o040000, '/dev is a directory');
for (const name of ['null', 'zero', 'full', 'random', 'urandom']) {
  const st = bfs.stat('/dev/' + name);
  ok(st && (st.mode & S_IFMT) === S_IFCHR, `/dev/${name} is a char device`);
}
eq(bfs.stat('/dev/null').rdev, makedev(1, 3), '/dev/null rdev 1:3');
eq(bfs.stat('/dev/zero').rdev, makedev(1, 5), '/dev/zero rdev 1:5');
eq(bfs.stat('/dev/urandom').rdev, makedev(1, 9), '/dev/urandom rdev 1:9');

// ---- 2. /dev/null: reads EOF, swallows writes ----
{
  const fd = bfs.open('/dev/null', O_RDWR, 0);
  ok(fd >= 0, 'open /dev/null');
  const rb = new Uint8Array(16).fill(0xAB);
  eq(bfs.read(fd, rb, 16), 0, '/dev/null read returns 0 (EOF)');
  eq(bfs.write(fd, new Uint8Array([1, 2, 3, 4]), 4), 4, '/dev/null write swallows all bytes');
  // fstat on the open fd reports the device too.
  eq(bfs.fstat(fd).mode & S_IFMT, S_IFCHR, '/dev/null fstat is char device');
  bfs.close(fd);
}

// ---- 3. /dev/zero: reads zeros, swallows writes ----
{
  const fd = bfs.open('/dev/zero', O_RDONLY, 0);
  const rb = new Uint8Array(4096).fill(0xFF);
  eq(bfs.read(fd, rb, 4096), 4096, '/dev/zero read fills the buffer');
  ok(rb.every(b => b === 0), '/dev/zero returns all zeros');
  bfs.close(fd);
}

// ---- 4. /dev/full: reads zeros, writes fail ENOSPC ----
{
  const fd = bfs.open('/dev/full', O_RDWR, 0);
  const rb = new Uint8Array(8).fill(0xFF);
  eq(bfs.read(fd, rb, 8), 8, '/dev/full read fills with zeros');
  ok(rb.every(b => b === 0), '/dev/full reads zeros');
  eq(bfs.write(fd, new Uint8Array([1]), 1), null, '/dev/full write fails');
  eq(bfs._lastError, 'ENOSPC', '/dev/full write sets ENOSPC');
  bfs.close(fd);
}

// ---- 5. /dev/urandom: fills with varied bytes (incl. > 65536 chunk loop) ----
{
  const fd = bfs.open('/dev/urandom', O_RDONLY, 0);
  const big = new Uint8Array(100000); // forces the >65536 getRandomValues loop
  eq(bfs.read(fd, big, big.length), big.length, '/dev/urandom fills the whole buffer');
  // Not all zeros, and the tail past 65536 was written too (varied bytes there).
  ok(big.some(b => b !== 0), '/dev/urandom produced non-zero bytes');
  ok(big.subarray(65536).some(b => b !== 0), '/dev/urandom filled past the 64K chunk');
  bfs.close(fd);
}

// ---- 6. /dev lists exactly the five nodes ----
{
  const h = bfs.opendir('/dev');
  const names = [];
  for (let e = bfs.readdir(h); e; e = bfs.readdir(h)) {
    if (e.name !== '.' && e.name !== '..') names.push(e.name);
  }
  bfs.closedir(h);
  names.sort();
  eq(names.join(','), 'full,null,random,urandom,zero', '/dev lists the five nodes');
}

// ---- 7. ensureDevNodes is idempotent + self-heals after unlink ----
{
  bfs.ensureDevNodes(); // no-op; must not duplicate or throw
  const h = bfs.opendir('/dev');
  let count = 0;
  for (let e = bfs.readdir(h); e; e = bfs.readdir(h)) {
    if (e.name !== '.' && e.name !== '..') count++;
  }
  bfs.closedir(h);
  eq(count, 5, 'ensureDevNodes did not duplicate nodes');

  eq(bfs.unlink('/dev/null'), 0, 'unlink /dev/null');
  ok(!bfs.stat('/dev/null'), '/dev/null gone after unlink');
  bfs.ensureDevNodes(); // self-heal
  const st = bfs.stat('/dev/null');
  ok(st && (st.mode & S_IFMT) === S_IFCHR, '/dev/null restored by ensureDevNodes');
}

// ---- 8. Devices survive a re-mount (persisted, and re-ensured) ----
{
  const bfs2 = createV4(store);
  const st = bfs2.stat('/dev/zero');
  ok(st && (st.mode & S_IFMT) === S_IFCHR && st.rdev === makedev(1, 5), '/dev/zero survives re-mount');
}

console.log(`\ndev: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
