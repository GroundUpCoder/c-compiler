# BLOCK_FS — synchronous POSIX filesystem backed by a single OPFS file

**Status**: implemented, tested, shipping behind `--block-fs` flag.  Not yet
battle-tested with vendor apps (Quake, Doom, Lua, SQLite, etc.) in the
browser.

## Motivation

`FileSystemSyncAccessHandle` (OPFS) provides synchronous `read()` / `write()`
/ `truncate()` / `getSize()` on a single file — no JSPI needed.  Store an
entire filesystem inside one OPFS file and every operation is synchronous.
This is the iOS / Safari path where `WebAssembly.Suspending` is not
available.

## Architecture

All code lives in a single IIFE in `host.js`:

```
ByteStore (abstract byte-addressable store)
  ├─ MemoryByteStore      — Uint8Array / DataView, for tests and Node CLI
  └─ SyncAccessHandleStore — wraps FileSystemSyncAccessHandle, for browser

TLSFAllocator (~400 lines)
  — Ported from compiler.js WASM malloc.  O(1) segregated fit.
  — Block header: size_and_flags(u32) + prev_phys(u32) [+ next_free(u32) +
    prev_free(u32) when free].
  — Metadata (~2KB): FL_bitmap, SL_bitmap[27], free_heads[27×16].
  — Pool starts at offset 2304 (256B superblock + 2048B TLSF metadata).
  — Grows via `_growPool` → `store.resize()`.

InodeTable
  — Flat array of 32-byte inodes, stored as a TLSF allocation.
  — Grows by 2× via TLSF realloc when full.
  — Inode ID = index, stable across table moves.

BlockFS
  — Extent-based: each file / directory is a single contiguous TLSF
    allocation.  Reads are one store call; writes within capacity are one
    call.  File growth triggers TLSF realloc (doubles capacity → amortised
    O(1) per byte appended).
  — 23 public methods covering the full POSIX surface.
  — `inspect()` returns superblock info, TLSF block walk with integrity
    verification, byte / block counts, free list consistency check.

toWasmEnv(ctx)
  — Adapts BlockFS to the WASM import interface expected by wasm-ld /
    compiler.js.  Identical signature to createBrowserFileSystem.
```

### On-disk layout

```
Offset 0:       Superblock (256 B)
Offset 256:     TLSF metadata (2048 B: bitmaps + free-list heads)
Offset 2304:    TLSF managed pool
                  ├─ Inode table extent (first TLSF alloc, growable)
                  ├─ Root dir extent (inode 1)
                  ├─ File / directory extents ...
```

### Inode (32 bytes)

```
[ 0: 4] extent_offset   uint32   TLSF ptr to data extent
[ 4: 8] extent_capacity uint32   allocated size
[ 8:12] data_size       uint32   logical file size
[12:14] mode            uint16   S_IFREG|0644 or S_IFDIR|0755
[14:16] nlink           uint16   dir-entry refcount
[16:20] mtime           uint32   epoch seconds
[20:24] ctime           uint32
[24:26] uid             uint16
[26:28] gid             uint16
[28:32] reserved        uint32
```

### Directory entry (variable-length, sorted by name)

```
[ 0: 4] inode_id   uint32
[ 4: 6] name_len   uint16
[ 6:6+N] name      uint8[N]
```

### Limits

- uint32 offsets throughout → individual files and total filesystem capped
  at ~4 GB.  Consistent with WASM's 32-bit address space.  Upgrade to
  uint64 / BigInt would lift this.
- 512 inodes with the default 8-block inode table; table auto-grows (2×
  realloc) so the practical limit is store space.
- No file permissions enforcement — mode bits stored and returned but not
  checked.

## Wiring

```
--block-fs CLI flag
  → compiler.js main() sets useBlockFS = true
  → HtmlOutput.generate() injects USE_BLOCK_FS into the HTML page
  → page sends msg.useBlockFS to the worker
  → worker's doRun() calls BLOCK_FS.init('__blockfs')
  → blockFsFactory(ctx) returns { c: blockFS.toWasmEnv(ctx) }
  → runModule dispatch (blockFsFactory branch) assembles imports
```

Node.js CLI path:
```
node host.js program.wasm --block-fs            ephemeral, 1 MB initial store
node host.js program.wasm --block-fs=/tmp/fs    file-backed, persists across runs
```

Test runner path:
```json
{"blockFs": true}
```
Adding this to any test's `config.json` makes `tests/run-unit.js` pass
`blockFsFactory` instead of `fs` to `runModule`.  The WASM binary is
identical regardless of backend — only the import providers differ.

## Exported WASM imports (32 total)

File I/O: `__open_impl`, `close`, `read`, `write`, `lseek`, `ftruncate`
Directory: `mkdir`, `rmdir`, `unlink`, `remove`, `rename`, `__opendir`,
  `__readdir`, `__closedir`
Metadata: `stat`, `lstat`, `fstat`, `access`, `chmod`, `fchmod`, `utime`
Process: `getcwd`, `chdir`, `pipe`, `dup`, `dup2`, `isatty`, `fcntl` (F_DUPFD)
Links: `link`, `symlink`, `readlink`
Terminal: `__tcgetattr`, `__tcsetattr`, `__ioctl_tiocgwinsz` (fake 80×24)
Stubs: `usleep` (ENOSYS), `__nanosleep` (ENOSYS), `__select_impl` (ENOSYS),
  `fsync` (no-op)

## JSPI independence

Every BlockFS method is synchronous after `BLOCK_FS.init()` (the one async
call).  JSPI-dependent syscalls (`usleep`, `__nanosleep`, `__select_impl` on
stdin, `__ioctl_tiocgwinsz`) return ENOSYS or fake data — identical to the
browser FS fallback path when JSPI is unavailable.  These syscalls are
independent of filesystem backend choice.

## Block FS vs createBrowserFileSystem (full OPFS)

| | Browser FS (multi-file OPFS) | Block FS (single-file) |
|---|---|---|
| Works on Safari / iOS | No (needs JSPI) | **Yes** |
| `sleep()` / `usleep()` | Works (JSPI) | ENOSYS |
| `select()` on stdin | Works (JSPI) | ENOSYS |
| Real terminal size | Works (JSPI) | Fake 80×24 |
| `rename()` | Copy + delete (O(n) data copy) | **O(1)** — moves dirent pointer |
| Hard links / symlinks | **Impossible** (no OPFS link API) | **Supported** |
| File size limit | Browser-dependent, >4 GB | 4 GB (uint32, fixable) |
| Filesystem inspectability | DevTools OPFS viewer | inspect() or download single file |
| Proven | Quake, Doom, Lua, SQLite, … | **New** |

## Test coverage

### JS-level tests (`tests/blockfs/`, run via `--types=blockfs`)

| File | Tests | Covers |
|---|---|---|
| `test_tlsf.js` | 15 | malloc/free, coalescing, splitting, realloc, calloc, random stress, double-free detection, state persistence |
| `test_blockfs.js` | 45 | Full POSIX API + stress: 500-entry dir, 100 concurrent fds, 2 MB single write, sequential growth, create/delete cycle, **100 MB file** with per-chunk marker verification + integrity check, **3×32 MB interleaved files**, **80 MB delete + space reclamation** with integrity check |
| `test_e2e.js` | 13 | Real C compilation + run through BlockFS: fopen/fwrite/fread, multiple files, stat, fseek/ftell, rename, opendir/readdir, stdout/stderr, 128 KB append, chdir/getcwd, **256 KB pattern verify** (exact byte-for-byte), truncate, **200 files** with read-back, random-access writes |

### Playwright browser tests (`tests/browser/test-blockfs.mjs`)

| Test | What |
|---|---|
| fopen / fwrite / fread | Write 10 bytes, read back, verify output in headless Chromium |
| stdout and stderr | Verify both streams appear correctly on the page |
| stat | stat two files, verify sizes |
| non-zero exit code | Return 42, verify status shows "Exit code: 42" |

### Standard unit tests (`tests/unit/blockfs*/`, `{"blockFs": true}`)

| Test | Covers |
|---|---|
| `blockfs` | fopen, fwrite, fread, stat |
| `blockfs_ftruncate` | `ftruncate(fd, size)` truncate to smaller size, verify |
| `blockfs_err_opendir_notdir` | opendir on file → ENOTDIR, on missing → ENOENT |
| `blockfs_err_mkdir_noparent` | mkdir in non-existent parent → ENOENT |
| `blockfs_err_chdir_notdir` | chdir to file → ENOTDIR, to missing → ENOENT |
| `blockfs_hardlink` | link, read both paths, unlink orig, alias survives |
| `blockfs_symlink` | symlink + readlink round-trip |
| `blockfs_chmod` | chmod to 0600, stat verifies mode |
| `blockfs_lseek_past_eof` | seek past EOF, write, verify extension to 105 bytes |
| `blockfs_empty_dir` | readdir on empty dir (only . and ..), rmdir succeeds |
| `blockfs_rename_overwrite` | rename A over B, verify content replaced + old gone |
| `blockfs_rmdir_nonempty` | rmdir non-empty → ENOTEMPTY, cleanup, rmdir succeeds |

**Totals**: 89 dedicated tests + 575 existing unit test regression suite
= 664 passing tests.  All run via `python3 tests/run.py --types=all`.

### Test gaps — not yet covered

| Function | Missing test |
|---|---|
| `fchmod` | No C-level unit test |
| `utime` | No C-level unit test |
| `fcntl` F_DUPFD | No C-level unit test |
| `fsync` | No C-level unit test |
| `lstat` | No C-level unit test (no symlinks to distinguish) |
| `pipe` / `dup` / `dup2` | Only JS-level tests, no C-level unit test |
| `isatty` | Only JS-level tests, no C-level unit test |
| `access` | Only JS-level tests, no C-level unit test |
| `fstat` | Only JS-level tests, no C-level unit test |
| `getcwd` | Only tested via error path (chdir), not normal operation |

## Still to do

- [x] **opfsFiles preloading** — `--opfs-file src:dst` files are now
  transferred to the worker via `postMessage` (zero-copy) and written into
  the block FS image after `BLOCK_FS.init()`.  A `/__bundle_hash` file
  inside the block FS tracks the bundle version so subsequent page loads
  skip rewriting identical assets.  (Node.js CLI path doesn't support
  opfsFiles — browser-only.)

### Immediate

- [ ] **C-level unit tests for the 10 untested WASM imports** listed above.
  Each is ~10 lines of C + `{"blockFs": true}` in config.json.

- [ ] **`select()` partial implementation**: the current stub returns ENOSYS
  for everything.  Could check regular files (always ready), pipes (check
  buffer), and only fail when stdin is in the fd set.  This would make
  `select()` useful for programs that don't need keyboard input.

### Medium-term

- [ ] **Vendor app testing**: compile Quake, Doom, Lua, SQLite, MicroPython
  with `--block-fs` and run through Playwright.  Compare against the
  existing browser FS path.

- [ ] **Directory indexing**: `dirFindInsertPos` does a linear scan (O(n)
  per insertion).  `dirLookup` builds an array of all offsets before binary
  searching.  For >1000 files, switch to a hash bucket or B-tree.  Real
  filesystems use HTree (ext4), B+ trees (NTFS, XFS), or hash tables
  (tmpfs).

- [ ] **S_IFLNK inode type**: symlinks are currently stored as `S_IFREG |
  0o777`.  A dedicated `S_IFLNK` type would let `lstat` distinguish them
  and let `open()` follow symlinks automatically (POSIX semantics).

- [ ] **`posix_fallocate`**: preallocate extent space to avoid the copy
  penalty when a program knows its file size in advance.

### Future

- [ ] **64-bit offsets**: upgrade superblock, TLSF metadata, inode pointers,
  and directory entries to uint64 / BigInt.  Lifts the 4 GB filesystem
  limit.

- [ ] **Journal / crash safety**: single OPFS file with syncHandle provides
  some consistency, but power loss mid-operation can corrupt the
  filesystem.  A write-ahead log would make it crash-safe.

- [ ] **Concurrent access**: OPFS locks the file while a syncAccessHandle is
  open.  Could support multiple readonly handles or a shared-memory
  protocol for multi-tab access.
