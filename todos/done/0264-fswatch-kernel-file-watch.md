# 0264 — FS_WATCH: kernel file-watch primitive + mgp live-reload + fileman auto-refresh

- **Status**: done (2026-07-18, ticket #75; landed with image v123)
- **Design**: `todos/KERNEL.md` (0x04xx opcode table, FS_WATCH_OPEN entry);
  external design study: gucos thread 019f7067 (inotify post-mortem →
  the path-keyed recommendation), run for ticket #75.

## Goal

The clean kernel file-watch primitive — NOT an mtime poll, NOT a per-inode
watch. Hook the `_fsRpc` mutation choke (every runtime fs mutation is one
RPC there with the path as a string) and expose a readable **watch fd**
served by the EXISTING select/FS_WAIT machinery, keyed by **canonical
path** so the editor rename-over-save (write tmp + rename onto the target
— the case a per-inode inotify watch structurally misses) lands a settled
event on the watched path and the watch survives. Wire the two real
consumers: mgp deck live-reload and fileman auto-refresh (absorbs the
deferred 0123, superseding its planned 500ms mtime poll).

## Plan

- kernel.js: `FS_WATCH_OPEN 0x0422` → a `'watch'` OFD ({canonical path,
  isDir, mask, queue, overflow latch}); emits from the mutating arms
  (write/ftruncate dirty-bit → settle at `_ofdUnref`'s last release,
  O_TRUNC/creat settle, unlink/rmdir/mkdir/link/symlink membership,
  rename as one two-name record + rename-onto settle); explicit
  `_selectScan` branch (the default arm is always-readable — mandatory);
  FS_READ drains packed records, EAGAIN when dry; overflow = clear+latch
  one FSW_OVERFLOW, the writer never blocked (strace 0046 rule).
- host.js: `__fs_watch` import (sock-family pattern — ENOSYS in-process,
  RemoteFS RPC brokered); shared C header `os/fswatch.h` (openwith.h
  precedent) with `fsw_open`/`fsw_drain`.
- mgp: the watch fd becomes `wantreload()`'s ONE source (upstream ctime
  poll deleted); `sdlx_wait_event_fd` composes it into the settled park.
- fileman: `watch_cwd()` re-armed per navigation over a NEW general user32
  seam `RegisterFdWake(hwnd, fd, msg)` (registered fds join GetMessage's
  unified WAIT; drained raw on wake; one posted message per episode);
  WM_FSCHANGE → refill with selection carried by NAME.
- Reserved, spec'd, not wired: `FSWF_RECURSIVE` (a prefix compare at the
  choke — cheap here precisely because keys are path strings); refused
  EINVAL until the first subtree consumer.
- Known residual (documented in fswatch.h): symlink/hardlink-ALIAS writes
  attribute to the alias's path — the fs surface has no physical resolver
  (realpath is lexical-only, todos/0263); `_watchCanon` is the one seam
  to upgrade when 0263 lands.

## Acceptance

- `tests/kernel/test_fswatch_e2e.js` (26 checks, red→green): cross-process
  settle-on-close, FS_WAIT park wake, THE rename-over settle, EAGAIN,
  SELF_GONE + re-arm, dir-watch names, one-record rename, zero-write
  O_TRUNC settle, overflow→single-record→EAGAIN with the writer unblocked,
  MODIFY opt-in, EINVAL/ENOENT refusals, clean close.
- `tests/kernel/test_mgp_livereload_e2e.js`: external deck edits (both
  tmp+rename-over and truncate-rewrite) re-render the live deck,
  background-color-proven.
- `tests/kernel/test_fileman_watch_e2e.js` (red→green): external
  create/rename-over/delete refresh the listing unprompted; the selection
  survives by name; navigation re-arms the watch.
