'use strict';
// fsck_v4 — an INDEPENDENT consistency checker for a BLOCK_FS *v4* image, the
// parallel of fsck.js (v3). Walks the raw bytes and re-derives what should be
// true, sharing NO code with host.js (only the on-disk v4 format, re-declared
// below and version-guarded), so a bug in host.js can't be masked by the same
// bug here. Read-only. Returns an array of problem strings ([] == clean).

// ---- v4 format constants (mirror host.js's TLSF64 + InodeTable128) ----
const MAGIC = 0x424C4B46; // "BLKF"
const VERSION = 4;
const SUPERBLOCK_SIZE = 256;
const TLSF_META_BASE = SUPERBLOCK_SIZE;          // allocator meta region
const TLSF_META_SIZE = 8192;
const TLSF_POOL_OFFSET = SUPERBLOCK_SIZE + TLSF_META_SIZE; // 8448

// superblock (v4): 64-bit inode-table extent at 16; cap 24; next-id 28; root 32
const SB_MAGIC = 0, SB_VERSION = 4, SB_FLAGS = 8;
const SB4_INODE_EXTENT = 16, SB4_INODE_CAP = 24, SB_NEXT_INODE_ID = 28, SB_ROOT_INODE = 32;
// Sealed blob (todos/0040): flags bit 1 + SHA-256 of bytes [256, size) at 36.
const SB_SEALED_BIT = 2, SB_SEAL_HASH = 36;

// TLSF64 meta offsets (relative to TLSF_META_BASE)
const FL_COUNT = 32, SL_COUNT = 16;
const M_FL_BITMAP = 0, M_SL_BITMAP = 4;
const M_FREE_HEADS = M_SL_BITMAP + FL_COUNT * 4;            // 132  (u64 entries)
const M_POOL_START = M_FREE_HEADS + FL_COUNT * SL_COUNT * 8; // 4228 (u64)
const M_POOL_END = M_POOL_START + 8;                        // 4236
const M_LAST_BLOCK = M_POOL_END + 8;                        // 4244

// block header (16 used / 32 free): size_and_flags(u64) is arithmetic size+flags
const FREE_BIT = 1, PREV_FREE_BIT = 2;
const BLOCK_OVERHEAD = 16, MIN_BLOCK_SIZE = 32;
const NEXT_FREE_OFF = 16;

// inode (128 bytes): mode|nlink packed at 0; extent_offset 8, extent_cap 16, data_size 24 (u64)
const INODE_SIZE = 128;
const I_MODE = 0, I_EXTENT_OFF = 8, I_EXTENT_CAP = 16, I_DATA_SIZE = 24;
const S_IFMT = 0o170000, S_IFDIR = 0o040000;
const DIR_ENT_HEADER = 6;
const ROOT_INO = 1;

function fsck(store) {
  const problems = [];
  const err = (m) => problems.push(m);
  const storeSize = store.size();
  // Bounds-safe readers: a checker must REPORT corruption (e.g. a garbage offset
  // from a corrupt inode), never crash on it. Out-of-range reads return 0 / empty.
  const u32 = (off) => (off >= 0 && off + 4 <= storeSize) ? store.getUint32(off) : 0;
  const u64 = (off) => (off >= 0 && off + 8 <= storeSize) ? (store.getUint32(off) + store.getUint32(off + 4) * 0x100000000) : 0;
  const bytes = (off, len) => (off >= 0 && len >= 0 && off + len <= storeSize) ? store.getBytes(off, len) : new Uint8Array(Math.max(0, len));
  const meta32 = (off) => u32(TLSF_META_BASE + off);
  const meta64 = (off) => u64(TLSF_META_BASE + off);

  // ---- Pass 0: superblock ----
  if (u32(SB_MAGIC) !== MAGIC) { err('bad magic (not a BlockFS image)'); return problems; }
  const version = u32(SB_VERSION);
  if (version !== VERSION) { err(`unsupported format version ${version} (fsck_v4 knows ${VERSION})`); return problems; }

  // ---- Pass 0b: sealed-volume integrity (todos/0040) ----
  // A baked read-only blob carries a content hash; ANY post-bake mutation
  // (a bug writing through the readonly guard, an accidental rw mount)
  // changes some byte after the superblock and breaks the seal.
  if ((u32(SB_FLAGS) & SB_SEALED_BIT) !== 0) {
    const want = Buffer.from(bytes(SB_SEAL_HASH, 32)).toString('hex');
    const got = require('crypto').createHash('sha256')
      .update(bytes(SUPERBLOCK_SIZE, storeSize - SUPERBLOCK_SIZE)).digest('hex');
    if (got !== want) err('sealed volume was mutated (seal hash mismatch)');
  }

  const poolStart = meta64(M_POOL_START);
  const poolEnd = meta64(M_POOL_END);
  if (poolStart !== TLSF_POOL_OFFSET) err(`poolStart ${poolStart} != expected ${TLSF_POOL_OFFSET}`);
  if (poolEnd <= poolStart) err(`poolEnd ${poolEnd} <= poolStart ${poolStart}`);
  if (poolEnd > storeSize) err(`poolEnd ${poolEnd} exceeds store size ${storeSize}`);
  if (problems.length) return problems;

  // ---- Pass 1: physical block walk ----
  const byPayload = new Map();    // payloadPtr -> { block, size, free, claimedBy }
  const freePhys = new Set();
  let block = poolStart, prev = 0, guard = 0;
  while (block < poolEnd) {
    if (++guard > 1e7) { err('pool walk exceeded iteration guard (corrupt block chain)'); break; }
    const word = u64(block);
    const flags = word % 4;
    const size = word - flags;
    const free = (flags & FREE_BIT) !== 0;
    if (size < MIN_BLOCK_SIZE) { err(`block @${block}: size ${size} < min ${MIN_BLOCK_SIZE}`); break; }
    if (size % 8 !== 0) { err(`block @${block}: size ${size} not 8-aligned`); break; }
    if (block + size > poolEnd) { err(`block @${block}: extends past poolEnd (${block}+${size} > ${poolEnd})`); break; }
    if (u64(block + 8) !== prev) err(`block @${block}: prev_phys ${u64(block + 8)} != actual ${prev}`);
    if (prev !== 0 && ((flags & PREV_FREE_BIT) !== 0) !== freePhys.has(prev)) {
      err(`block @${block}: PREV_FREE bit disagrees with previous block's free state`);
    }
    byPayload.set(block + BLOCK_OVERHEAD, { block, size, free, claimedBy: null });
    if (free) freePhys.add(block);
    prev = block;
    block += size;
  }
  if (!problems.length && block !== poolEnd) err(`blocks do not tile the pool exactly (ended at ${block}, poolEnd ${poolEnd})`);

  // ---- Pass 1b: free-list <-> physical-free cross-check ----
  const freeListed = new Set();
  for (let i = 0; i < FL_COUNT * SL_COUNT; i++) {
    let b = meta64(M_FREE_HEADS + i * 8), g = 0;
    while (b !== 0) {
      if (++g > 1e7 || freeListed.has(b)) { err(`free-list ${i}: cycle or shared node @${b}`); break; }
      freeListed.add(b);
      if (!freePhys.has(b)) err(`free-list ${i}: block @${b} is on a free list but not physically free`);
      b = u64(b + NEXT_FREE_OFF);
    }
  }
  for (const b of freePhys) if (!freeListed.has(b)) err(`block @${b} is physically free but on no free list (lost free block)`);

  // ---- Pass 2: inode table + extents (claim blocks; detect double-claim) ----
  const inodeTblExtent = u64(SB4_INODE_EXTENT);
  const inodeTblCap = u32(SB4_INODE_CAP);
  const nextInodeId = u32(SB_NEXT_INODE_ID);
  const rootInode = u32(SB_ROOT_INODE);
  if (rootInode !== ROOT_INO) err(`root inode ${rootInode} != ${ROOT_INO}`);
  if (nextInodeId < 2) err(`nextInodeId ${nextInodeId} < 2`);

  const claim = (payloadPtr, capNeeded, owner) => {
    const blk = byPayload.get(payloadPtr);
    if (!blk) { err(`${owner}: extent ptr ${payloadPtr} is not an allocated block`); return; }
    if (blk.free) err(`${owner}: extent ptr ${payloadPtr} points to a FREE block`);
    if (blk.claimedBy !== null) err(`${owner}: extent ${payloadPtr} already claimed by ${blk.claimedBy} (double-allocation)`);
    else blk.claimedBy = owner;
    if (blk.size - BLOCK_OVERHEAD < capNeeded) err(`${owner}: block payload ${blk.size - BLOCK_OVERHEAD} < needed ${capNeeded}`);
  };

  claim(inodeTblExtent, inodeTblCap * INODE_SIZE, 'inode-table');

  const live = new Map();
  for (let ino = 1; ino < nextInodeId; ino++) {
    if (ino >= inodeTblCap) { err(`inode id ${ino} >= table capacity ${inodeTblCap}`); break; }
    const off = inodeTblExtent + ino * INODE_SIZE;
    const modeWord = u32(off + I_MODE);
    const mode = modeWord & 0xFFFF;
    if (mode === 0) continue; // free slot
    const nlink = (modeWord >>> 16) & 0xFFFF;
    const extentOffset = u64(off + I_EXTENT_OFF);
    const extentCap = u64(off + I_EXTENT_CAP);
    const dataSize = u64(off + I_DATA_SIZE);
    const isDir = (mode & S_IFMT) === S_IFDIR;
    if (dataSize > extentCap) err(`inode ${ino}: dataSize ${dataSize} > extentCap ${extentCap}`);
    if (extentOffset === 0) {
      if (dataSize !== 0 || extentCap !== 0) err(`inode ${ino}: null extent but dataSize ${dataSize}/cap ${extentCap}`);
    } else {
      claim(extentOffset, extentCap, `inode ${ino}`);
    }
    live.set(ino, { mode, extentOffset, dataSize, nlink, isDir });
  }

  // ---- Pass 1c: every USED block must be claimed (no leaks) ----
  for (const [payload, blk] of byPayload) {
    if (!blk.free && blk.claimedBy === null) err(`used block @${blk.block} (payload ${payload}) is unreferenced (leak)`);
  }

  // ---- Pass 3: walk the directory tree ----
  const refcount = new Map();
  const seenDirs = new Set();
  const bump = (ino) => refcount.set(ino, (refcount.get(ino) || 0) + 1);
  const rootEnt = live.get(ROOT_INO);
  if (!rootEnt) err(`root inode ${ROOT_INO} is not a live inode`);
  else if (!rootEnt.isDir) err('root inode is not a directory');

  const walkDir = (ino, path) => {
    if (seenDirs.has(ino)) { err(`directory cycle: inode ${ino} reached twice (${path})`); return; }
    seenDirs.add(ino);
    const d = live.get(ino);
    if (!d || !d.isDir || d.extentOffset === 0) return;
    let pos = 0, g = 0;
    while (pos < d.dataSize) {
      if (++g > 1e6) { err(`dir ${ino}: entry walk exceeded guard`); break; }
      if (pos + DIR_ENT_HEADER > d.dataSize) break;
      const entIno = u32(d.extentOffset + pos);
      const nameLen = u32(d.extentOffset + pos + 4) & 0xFFFF;
      if (pos + DIR_ENT_HEADER + nameLen > d.dataSize) break;
      const stride = DIR_ENT_HEADER + nameLen;
      if (entIno !== 0) {
        const name = new TextDecoder().decode(bytes(d.extentOffset + pos + 6, nameLen));
        if (name !== '.' && name !== '..') {
          if (nameLen === 0) err(`dir ${ino}: empty entry name`);
          const target = live.get(entIno);
          if (!target) err(`dir ${ino}: entry '${name}' -> inode ${entIno} which is not live`);
          else { bump(entIno); if (target.isDir) walkDir(entIno, path + '/' + name); }
        }
      }
      pos += stride;
    }
  };
  if (rootEnt && rootEnt.isDir) walkDir(ROOT_INO, '');

  // ---- Pass 4: reachability + nlink ----
  for (const [ino, info] of live) {
    if (ino === ROOT_INO) continue;
    if (!refcount.has(ino)) err(`inode ${ino} is live but unreachable from root (orphan)`);
    if (!info.isDir) {
      const rc = refcount.get(ino) || 0;
      if (info.nlink !== rc) err(`inode ${ino}: nlink ${info.nlink} != dirent refcount ${rc}`);
    }
  }

  return problems;
}

function assertFsck(store, label) {
  const problems = fsck(store);
  if (problems.length) throw new Error(`fsck_v4${label ? ' [' + label + ']' : ''}: ${problems.length} problem(s):\n  - ` + problems.join('\n  - '));
}

module.exports = { fsck, assertFsck, FSCK_VERSION: VERSION };
