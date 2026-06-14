'use strict';
// fsck — an INDEPENDENT consistency checker for a BlockFS image.
//
// It walks the raw bytes of a store and re-derives, from scratch, what should
// be true, then cross-checks that against what the metadata claims. It shares
// NO code with host.js (only the on-disk format constants, re-declared below
// and version-guarded), so a bug in BlockFS can't be masked by the same bug
// here. Read-only; never mutates the store.
//
// Returns an array of human-readable problem strings ([] == clean). Designed to
// be called after every mutation in tests so corruption is caught at the exact
// operation that caused it, not as a mysterious read failure later.
//
// MUST match host.js's on-disk format. fsck guards on the superblock VERSION,
// so a format bump fails loudly here instead of silently misreading.

// ---- format constants (mirror host.js) ----
const MAGIC = 0x424C4B46; // "BLKF"
const VERSION = 3;
const SUPERBLOCK_SIZE = 256;
const TLSF_META_BASE = SUPERBLOCK_SIZE; // allocator meta region starts here
const TLSF_POOL_OFFSET = 2304;          // SUPERBLOCK_SIZE + TLSF_META_SIZE(2048)

// superblock field offsets
const SB_MAGIC = 0, SB_VERSION = 4, SB_TLSF_POOL_OFFSET = 12, SB_TLSF_POOL_SIZE = 16;
const SB_INODE_TBL_EXTENT = 20, SB_INODE_TBL_CAP = 24, SB_NEXT_INODE_ID = 28, SB_ROOT_INODE = 32;

// TLSF meta field offsets (relative to TLSF_META_BASE). Computed from FL/SL
// counts — NOT the stale "//1840" comments in host.js, which predate FL_COUNT=29.
// fsck cross-checks the computed pool_start against the superblock below, so a
// wrong offset fails loudly instead of misreading.
const FL_COUNT = 29, SL_COUNT = 16;
const META_SL_BITMAP = 4;
const META_FREE_HEADS = META_SL_BITMAP + FL_COUNT * 4;            // 120
const META_POOL_START = META_FREE_HEADS + FL_COUNT * SL_COUNT * 4; // 1976
const META_POOL_END = META_POOL_START + 4;
const META_LAST_BLOCK = META_POOL_END + 4;

// block header
const FLAG_BITS = 3, FREE_BIT = 1, PREV_FREE_BIT = 2;
const BLOCK_OVERHEAD = 8, MIN_BLOCK_SIZE = 16;

// inode
const INODE_SIZE = 32;
const INO_EXTENT_OFFSET = 0, INO_EXTENT_CAP = 4, INO_DATA_SIZE = 8, INO_MODE = 12;
const S_IFMT = 0o170000, S_IFDIR = 0o040000;

// directory entry
const DIR_ENT_HEADER = 6;

const ROOT_INO = 1;

function fsck(store) {
  const problems = [];
  const err = (m) => problems.push(m);
  const u32 = (off) => store.getUint32(off);
  const meta = (off) => store.getUint32(TLSF_META_BASE + off);
  const storeSize = store.size();

  // ---- Pass 0: superblock ----
  if (u32(SB_MAGIC) !== MAGIC) { err('bad magic (not a BlockFS image)'); return problems; }
  const version = u32(SB_VERSION);
  if (version !== VERSION) { err(`unsupported format version ${version} (fsck knows ${VERSION})`); return problems; }

  const poolStart = meta(META_POOL_START);
  const poolEnd = meta(META_POOL_END);
  if (poolStart !== TLSF_POOL_OFFSET) err(`poolStart ${poolStart} != expected ${TLSF_POOL_OFFSET}`);
  if (poolEnd <= poolStart) err(`poolEnd ${poolEnd} <= poolStart ${poolStart}`);
  if (poolEnd > storeSize) err(`poolEnd ${poolEnd} exceeds store size ${storeSize}`);
  if (problems.length) return problems; // can't safely walk a broken pool

  // ---- Pass 1: physical block walk → block map ----
  // blocks keyed by payload pointer (block + BLOCK_OVERHEAD), which is what
  // malloc returns and what inodes/superblock store as extent pointers.
  const byPayload = new Map(); // payloadPtr -> { block, size, free, claimedBy }
  const freePhys = new Set();  // block offsets that are physically free
  let block = poolStart;
  let prev = 0;
  let guard = 0;
  while (block < poolEnd) {
    if (++guard > 1e7) { err('pool walk exceeded iteration guard (corrupt block chain)'); break; }
    const word = u32(block);
    const size = (word & ~FLAG_BITS) >>> 0;
    const free = (word & FREE_BIT) !== 0;
    if (size < MIN_BLOCK_SIZE) { err(`block @${block}: size ${size} < min ${MIN_BLOCK_SIZE}`); break; }
    if (size % 8 !== 0) { err(`block @${block}: size ${size} not 8-aligned`); break; }
    if (block + size > poolEnd) { err(`block @${block}: extends past poolEnd (${block}+${size} > ${poolEnd})`); break; }
    if (u32(block + 4) !== prev) err(`block @${block}: prev_phys ${u32(block + 4)} != actual ${prev}`);
    if (prev !== 0 && ((word & PREV_FREE_BIT) !== 0) !== freePhys.has(prev)) {
      err(`block @${block}: PREV_FREE bit disagrees with previous block's free state`);
    }
    byPayload.set(block + BLOCK_OVERHEAD, { block, size, free, claimedBy: null });
    if (free) freePhys.add(block);
    prev = block;
    block += size;
  }
  if (!problems.length && block !== poolEnd) err(`blocks do not tile the pool exactly (ended at ${block}, poolEnd ${poolEnd})`);

  // ---- Pass 1b: free-list ↔ physical-free cross-check ----
  const freeListed = new Set();
  for (let i = 0; i < FL_COUNT * SL_COUNT; i++) {
    let b = meta(META_FREE_HEADS + i * 4);
    let g = 0;
    while (b !== 0) {
      if (++g > 1e7 || freeListed.has(b)) { err(`free-list ${i}: cycle or shared node @${b}`); break; }
      freeListed.add(b);
      if (!freePhys.has(b)) err(`free-list ${i}: block @${b} is on a free list but not physically free`);
      b = u32(b + BLOCK_OVERHEAD); // next_free
    }
  }
  for (const b of freePhys) if (!freeListed.has(b)) err(`block @${b} is physically free but on no free list (lost free block)`);

  // ---- Pass 2: inode table + extents (claim blocks; detect double-claim) ----
  const inodeTblExtent = u32(SB_INODE_TBL_EXTENT);
  const inodeTblCap = u32(SB_INODE_TBL_CAP);
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

  const live = new Map(); // ino -> { mode, extentOffset, dataSize, nlink, isDir }
  for (let ino = 1; ino < nextInodeId; ino++) {
    if (ino >= inodeTblCap) { err(`inode id ${ino} >= table capacity ${inodeTblCap}`); break; }
    const off = inodeTblExtent + ino * INODE_SIZE;
    const modeWord = u32(off + INO_MODE);
    const mode = modeWord & 0xFFFF;
    if (mode === 0) continue; // free slot
    const nlink = modeWord >>> 16;
    const extentOffset = u32(off + INO_EXTENT_OFFSET);
    const extentCap = u32(off + INO_EXTENT_CAP);
    const dataSize = u32(off + INO_DATA_SIZE);
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

  // ---- Pass 3: walk the directory tree from root ----
  const refcount = new Map(); // ino -> number of dirents pointing at it
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
      if (entIno !== 0) { // 0 = deleted entry
        const name = new TextDecoder().decode(store.getBytes(d.extentOffset + pos + 6, nameLen));
        if (name !== '.' && name !== '..') {
          if (nameLen === 0) err(`dir ${ino}: empty entry name`);
          const target = live.get(entIno);
          if (!target) err(`dir ${ino}: entry '${name}' -> inode ${entIno} which is not live`);
          else {
            bump(entIno);
            if (target.isDir) walkDir(entIno, path + '/' + name);
          }
        }
      }
      pos += stride;
    }
  };
  if (rootEnt && rootEnt.isDir) walkDir(ROOT_INO, '');

  // ---- Pass 4: reachability + nlink cross-checks ----
  for (const [ino, info] of live) {
    if (ino === ROOT_INO) continue; // root is the tree root, not referenced by a parent here
    if (!refcount.has(ino)) err(`inode ${ino} is live but unreachable from root (orphan)`);
    // Regular files: nlink must equal the number of dirents pointing at it
    // (hardlinks). Directory nlink conventions ('.'/'..') vary, so only files
    // get the strict check.
    if (!info.isDir) {
      const rc = refcount.get(ino) || 0;
      if (info.nlink !== rc) err(`inode ${ino}: nlink ${info.nlink} != dirent refcount ${rc}`);
    }
  }

  return problems;
}

/** Throw with all problems if the image is inconsistent. `label` for context. */
function assertFsck(store, label) {
  const problems = fsck(store);
  if (problems.length) {
    throw new Error(`fsck${label ? ' [' + label + ']' : ''}: ${problems.length} problem(s):\n  - ` + problems.join('\n  - '));
  }
}

module.exports = { fsck, assertFsck, FSCK_VERSION: VERSION };
