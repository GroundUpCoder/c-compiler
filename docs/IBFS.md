# IBFS

**IBFS** (Indexed BlockFS) is this repository's indexed implementation of BlockFS.
`BLOCK_FS.implementationName` exposes that name; the `BLOCK_FS` API and v3/v4
disk layouts are unchanged because this optimization needs no new persisted
structures. Old-disk compatibility is not a design constraint for future work.
The upstream integration is ticket #801, introduced with gucOS image 300.

## Directory indexing

Previously every pathname component lookup read the directory's packed bytes,
decoded every name, built an offset list, and then performed a binary search.
Repeated `stat` or `open` calls consequently cost O(directory entries) per
component even when the entire disk was already in RAM.

The first lookup now builds a name-to-entry map and a sorted entry array.
Subsequent lookups use the map. Insertions binary-search the sorted array;
insertions and removals update the cached offsets without decoding unchanged
names. Packed bytes still move on insertion/removal, so these operations remain
linear in the affected suffix. Directory growth can require rebuilding the
index at the new extent. Enumeration copies entries into the existing per-handle
snapshot so later mutations cannot change a listing in progress.

Indexes are disposable derived data. Inode tables and allocator metadata remain
read-through. Each backing store retains at most 128 directories, 65,536 entries,
and 4 MiB of encoded directory data, evicting least recently used directories.
These are structural limits, not a claim that JavaScript objects occupy 4 MiB.
Oversized directories work without retaining their index.

## Coherence contract

A byte store may implement `watchWrites(listener)`, calling the listener with
`(offset, length)` synchronously on every byte mutation. Notify before a write
that can partially succeed and throw. Stores without this
capability remain uncached. Immutable, sealed SabByteStore volumes need no
notifications.

Indexes belong to a store, rather than to a filesystem instance. ReadOnlyStore
views share their underlying store's identity; SyncAccessHandleStore wrappers
around the same handle share that handle's identity. NodeFileStore descriptors
opened on the same native device/inode notify a shared domain, including
hard-link aliases; closing a descriptor unregisters its listeners. Overlapping writes invalidate
indexes, including raw writes through the store API. Logical directory mutations
detach their index before writing and republish it only after successful writes.
Each write checks at most 128 cached ranges. Size changes are checked on lookup.

Writes bypassing the byte-store API (including direct buffer or handle mutation)
are outside this contract. Distinct handles or JavaScript realms do not acquire a
shared cache-invalidation mechanism from this change. The browser's writable
filesystem continues to have one owner; headless boots enforce the existing
root-image lock. Immutable package volumes may be shared.
This is not a new concurrent-writer filesystem protocol.

## Verification and measurement

`node tests/blockfs/test_directory_index.js` checks v3/v4 coherence across live
mounts, aliases, read-only views, raw writes, partial write failures, renames,
links, extent growth, Unicode names, snapshot isolation, cache eviction and
untracked-store fallback. Native file tests cover two descriptors on hard-linked
paths and replacement of one pathname with a new inode. Warm lookup assertions
require zero additional directory-index builds. The test is registered in
`node tests/blockfs/run.js`; independent fsck and dual-instance fuzz tests remain
part of the same suite.

The source change was ported from wasm-posix `d81420bc`, whose reproducible
`tools/bench-blockfs.mjs` and `docs/measurements/indexed-blockfs.json` record
isolated memory-backed measurements. At 5,000 files: median warm stat fell from
1,740 to 1.62 microseconds; front insertion/deletion pair from 7,036 to 65.8
microseconds. First lookup rose from 1,775 to 2,152 microseconds. These exclude
RPC and OPFS and are not a claim about gucOS startup or frame latency.

The old scan/binary-search helper is replaced, not retained as a selectable
implementation. No migration layer, disk conversion, or old-disk preservation
logic is added. The v3/v4 code used by existing embedders is otherwise unchanged.

## Deployment handoff (image 300)

The user will deploy separately from the already-configured deployment machine.
All runtime code and the image-version bump live in this repository; no generated
blob or machine-local package cache needs committing. The existing comguc
publisher builds these sources and writes the release provenance.

1. Pull this repository and confirm a clean checkout of the IBFS commit. Read
   `logs/2026-09-28/801-ibfs.md` for validation evidence. Before publishing, run
   `node tests/run.js full` without filter/resume on the release machine. If its
   cold image builds exceed five minutes, use the test's documented
   `CC_OS_BOOT_TIMEOUT_MS=600000` session budget; retain the full gate result.
   This does not extend the kernel runner's separate 15-minute file limit;
   the implementation machine still hit that limit during the third cold bake.
   The implementation machine also has an old July 11 clang overlay whose
   `sameboy-clang` executable has no package definition here.
   SameBoy clang packaging remains blocked on the matching Win32 frontend (#378).
   Do not package the old SDL artifact to bypass that requirement. Resolve
   sibling artifact/package drift before treating the full release gate as
   green; see the engineering log for the exact failing tests.
   The GPU lifecycle browser check also has unresolved rendering failures (#802).
   Resolve that release blocker and obtain a green full gate before publishing.
2. In the configured `~/git/comguc` checkout, use the existing deployment runbook
   (`README.md` and `deploys/README.md`). This is an **image-only** release:
   `pnpm build:image` rebuilds the minimal sealed system image and runtime JS,
   while carrying `c-compiler/dist/packages` verbatim. Confirm that local package
   catalog matches the current published `/packages/index.json`, with every
   referenced payload present; do not substitute an incomplete development cache.
3. Run `pnpm verify`, `pnpm test:floor` and `pnpm test:ledger`. Inspect
   `dist/build-info.json`: clean expected c-compiler commit, `mode: image-only`;
   `dist/os/image.json` must name version 300 (or the intentionally newer release).
4. With the deployment machine's existing Cloudflare authentication, use
   `pnpm run deploy`. Verify both its immutable Pages URL and
   `https://groundupcoder.com/build-info.json` against the candidate, then commit
   and push comguc's generated `deploys/log.jsonl` entry.

No deployment was performed from the implementation machine. No old user disks
were erased. The old directory scan is removed; no new compatibility or migration
machinery is required to deploy IBFS.
