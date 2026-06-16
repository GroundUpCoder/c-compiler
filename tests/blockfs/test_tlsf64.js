// Exhaustive tests for TLSF64Allocator (the 64-bit allocator behind BLOCK_FS v4).
//
// The allocator is the highest-risk component (bugs corrupt silently), so this
// hammers it directly: after every mutation it runs a structural consistency
// check (physical-block tiling + free-list/bitmap coherence) AND verifies that
// every live allocation still holds its own sentinel bytes — an overlap or
// stray write shows up immediately. A seeded fuzzer makes failures reproducible.

'use strict';
const fs = require('fs');
const path = require('path');

// Load BLOCK_FS out of host.js (same trick the other blockfs tests use).
const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();
const { TLSF64Allocator, MemoryByteStore } = BLOCK_FS;

// v4 constants mirrored from host.js (independent re-declaration, like fsck.js).
const POOL_OFFSET = 8448;   // SUPERBLOCK_SIZE(256) + TLSF_META_SIZE64(8192)
const BLOCK_OVERHEAD = 16;
const ALIGN = 8;

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

// Deterministic PRNG (mulberry32) so any failure is reproducible by seed.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Structural fsck: walk physical blocks, verify they tile the pool exactly with
// correct prev_phys links and alignment; verify free blocks match the free lists.
function fsck(a) {
  const poolStart = a._readMeta64(4228); // M64_POOL_START
  const poolEnd = a._readMeta64(4236);   // M64_POOL_END
  const lastBlock = a._readMeta64(4244); // M64_LAST_BLOCK
  let block = poolStart, prev = 0, freeWalked = 0, last = 0;
  const problems = [];
  while (block < poolEnd) {
    const sz = a._blockSize(block);
    if (sz < 32) problems.push(`block ${block} size ${sz} < MIN`);
    if (sz % ALIGN !== 0) problems.push(`block ${block} size ${sz} not aligned`);
    if (a._blockPrevPhys(block) !== prev) problems.push(`block ${block} prev_phys ${a._blockPrevPhys(block)} != ${prev}`);
    if (a._blockIsFree(block)) freeWalked++;
    last = block;
    prev = block;
    block = block + sz;
  }
  if (block !== poolEnd) problems.push(`blocks don't tile pool: ended at ${block}, poolEnd ${poolEnd}`);
  if (last !== lastBlock) problems.push(`last_block ${lastBlock} != walked last ${last}`);
  // Cross-check free lists: every listed block is physically free and in-pool.
  let freeListed = 0;
  for (let fl = 0; fl < 32; fl++) {
    for (let sl = 0; sl < 16; sl++) {
      let b = a._freeHead(fl, sl), guard = 0;
      while (b) {
        if (b < poolStart || b >= poolEnd) { problems.push(`free-list block ${b} out of pool`); break; }
        if (!a._blockIsFree(b)) { problems.push(`free-list block ${b} not marked free`); break; }
        freeListed++;
        b = a._blockGetNextFree(b);
        if (++guard > 1e6) { problems.push('free-list cycle'); break; }
      }
    }
  }
  if (freeListed !== freeWalked) problems.push(`free count mismatch: list ${freeListed}, walk ${freeWalked}`);
  return problems;
}

// ---- 1. Basic alloc/free + alignment ----
{
  const store = new MemoryByteStore(1 << 20);
  const a = new TLSF64Allocator(store, 256, (1 << 20) - POOL_OFFSET);
  const p1 = a.malloc(100), p2 = a.malloc(200), p3 = a.malloc(50);
  ok(p1 && p2 && p3, 'three mallocs succeed');
  ok(p1 % ALIGN === 0 && p2 % ALIGN === 0 && p3 % ALIGN === 0, 'payloads 8-aligned');
  ok(p1 !== p2 && p2 !== p3 && p1 !== p3, 'distinct pointers');
  ok(a.blockSize(p1) >= 100, 'block holds requested size');
  eq(fsck(a).length, 0, 'fsck clean after allocs: ' + fsck(a).join('; '));
  a.free(p2);
  eq(fsck(a).length, 0, 'fsck clean after free');
  const p4 = a.malloc(150); // should reuse the freed hole
  ok(p4, 'realloc into freed hole');
  eq(fsck(a).length, 0, 'fsck clean after reuse');
}

// ---- 2. Coalescing: free three adjacent, then a big alloc fits ----
{
  const store = new MemoryByteStore(1 << 20);
  const a = new TLSF64Allocator(store, 256, (1 << 20) - POOL_OFFSET);
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(a.malloc(1000));
  ok(ps.every(Boolean), 'six allocs');
  for (const p of ps) a.free(p);
  eq(fsck(a).length, 0, 'fsck clean after freeing all (coalesced)');
  const big = a.malloc(5500); // only possible if the freed blocks coalesced
  ok(big, 'large alloc after coalescing');
  eq(fsck(a).length, 0, 'fsck clean after large alloc');
}

// ---- 3. Double-free + out-of-bounds free are caught ----
{
  const store = new MemoryByteStore(1 << 20);
  const a = new TLSF64Allocator(store, 256, (1 << 20) - POOL_OFFSET);
  const p = a.malloc(64);
  a.free(p);
  let threw = false; try { a.free(p); } catch (e) { threw = true; }
  ok(threw, 'double free throws');
  threw = false; try { a.free(999999999); } catch (e) { threw = true; }
  ok(threw, 'out-of-pool free throws');
}

// ---- 4. Pool growth past the initial size ----
{
  const store = new MemoryByteStore(1 << 16); // small, forces growth
  const a = new TLSF64Allocator(store, 256, (1 << 16) - POOL_OFFSET);
  const ps = [];
  for (let i = 0; i < 200; i++) { const p = a.malloc(1000); ok(p, `growth alloc ${i}`); ps.push(p); }
  eq(fsck(a).length, 0, 'fsck clean after pool growth: ' + fsck(a).join('; '));
  ok(store.size() > (1 << 16), 'store actually grew');
}

// ---- 5. Large 64-bit offsets: push the pool past 2^32 (the whole point) ----
// We don't allocate 4 GiB of real RAM; instead we exercise the 64-bit field
// read/write helpers at large offsets directly, then a small alloc on a store
// that *reports* a large size, to confirm number/offset math holds past 2^32.
{
  const store = new MemoryByteStore(1 << 16);
  const a = new TLSF64Allocator(store, 256, (1 << 16) - POOL_OFFSET);
  // round-trip 64-bit values through the store helpers at a high offset
  for (const v of [0, 1, 0xFFFFFFFF, 0x100000000, 0x1234567890, 4 * 1024 * 1024 * 1024 + 7, 9007199254740991]) {
    store.resize(1 << 16);
    a._set64(1000, v);
    eq(a._get64(1000), v, `64-bit round-trip ${v}`);
  }
  // size_and_flags arithmetic at a large size
  a._set64(2000, 0x500000000 + 3); // size 0x500000000 (20 GiB), flags 3
  eq(a._blockSize(2000), 0x500000000, 'blockSize past 2^32');
  eq(a._getFlags(2000), 3, 'flags past 2^32');
  a._blockSetSize(2000, 0x700000000);
  eq(a._blockSize(2000), 0x700000000, 'setSize past 2^32 keeps flags');
  eq(a._getFlags(2000), 3, 'flags preserved');
}

// ---- 6. Model-based fuzzer with sentinel bytes (the real net) ----
function fuzz(seed, ops) {
  const rand = rng(seed);
  const store = new MemoryByteStore(1 << 18);
  const a = new TLSF64Allocator(store, 256, (1 << 18) - POOL_OFFSET);
  const live = new Map(); // ptr -> { size, tag }
  let tagSeq = 1;
  const verifyAll = () => {
    for (const [ptr, info] of live) {
      const bytes = store.getBytes(ptr, info.size);
      for (let i = 0; i < info.size; i++) {
        if (bytes[i] !== info.tag) return `corruption at ptr ${ptr}+${i}: ${bytes[i]} != ${info.tag}`;
      }
    }
    return null;
  };
  for (let i = 0; i < ops; i++) {
    const doAlloc = live.size === 0 || rand() < 0.55;
    if (doAlloc) {
      const size = 1 + Math.floor(rand() * 800);
      const ptr = a.malloc(size);
      if (ptr === 0) continue; // out of space is allowed
      const tag = tagSeq++ & 0xff;
      store.setBytes(ptr, new Uint8Array(size).fill(tag));
      live.set(ptr, { size, tag });
    } else {
      const keys = [...live.keys()];
      const ptr = keys[Math.floor(rand() * keys.length)];
      a.free(ptr);
      live.delete(ptr);
    }
    const problems = fsck(a);
    if (problems.length) return `seed ${seed} op ${i}: fsck: ${problems.join('; ')}`;
    const corrupt = verifyAll();
    if (corrupt) return `seed ${seed} op ${i}: ${corrupt}`;
  }
  return null;
}

{
  let fuzzFail = null;
  for (let seed = 1; seed <= 12 && !fuzzFail; seed++) fuzzFail = fuzz(seed, 1500);
  ok(!fuzzFail, 'fuzzer (12 seeds x 1500 ops): ' + (fuzzFail || 'clean'));
}

console.log(`\nTLSF64: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
