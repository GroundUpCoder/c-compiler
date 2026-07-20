# In-OS read() now FILLS regular-file reads (0140 option B) — the mGBA short-read class, fixed

**Date:** 2026-07-20
**Branch:** `os-read-fill-0140`
**Ticket:** `todos/0140-mgba-cpu-miscompile.md`
**Root cause (established):** `logs/2026-07-20/mgba-crt0-codegen-fix.md`

## What was broken

The in-OS process-side `read()` short-read the WHOLE class of large
regular-file reads. `RemoteFS.prototype.read` (kernel.js) capped each
`FS_READ` RPC at `KP_FS_CHUNK` (60000 B) and returned after **one** chunk, so a
single `read(fd, buf, N)` with `N > KP_FS_CHUNK` returned only the first 60000
bytes — a silent truncation. Any program that trusts a regular-file `read()` to
fill (POSIX permits short reads, but native Linux/Node fill regular files, so
real code frequently doesn't loop) got a partially-populated buffer.

mGBA was the first victim: its non-`mmap` `_vfdMap` ROM loader (`vfs-fd.c`)
`calloc`s a 16 MB buffer and does one unlooped `read(fd, mem, 16MB)`, ignoring
the return. In-OS that left the ROM zero-tailed → the emulated ARM7TDMI read
open-bus ROM → `BX` to `0x09000000` → 1.5 M "Jumped to invalid address" lines,
a 100%-white window. Bare `node host.js` boots the same wasm clean because
`fs.readSync` fills 16 MB in one call — which is exactly why the prior threads,
testing bare, could not reproduce and mis-blamed compiler.js codegen.

Per jku's decision: **option B only** (the general in-OS read-fill), NOT option
A (patching mGBA's unlooped read). The bug is ours; fix it once at the read
layer so the whole class is fixed, not just mGBA.

## The fix — one layer, scoped to regular files

`kernel.js`, `RemoteFS.prototype.read` (the process-side brokered read path —
the exact `Math.min(count, KP_FS_CHUNK)`-capped RPC named in the root-cause
log). The kernel can't return more than one chunk per RPC (each reply is bounded
by the transport payload `KP_PAYLOAD_CAP`), so the fill loops the RPC
**process-side**:

- After the first `FS_READ`, if the caller still wants more **and** the first
  chunk came back FULL (`got === KP_FS_CHUNK` — a short first chunk is already
  EOF) **and** the fd is a **regular file**, loop `FS_READ` until `count` is
  satisfied or a short chunk signals EOF.
- **Scoping to regular files** is the load-bearing guard rail: ttys, pipes,
  sockets, char-devices and the master pty legitimately short-read, and looping
  them would block on data that may never arrive. Classification is
  `RemoteFS.prototype._isRegularFd` — one `FS_FSTAT` RPC, `(st.mode & 0xF000)
  === 0x8000` (S_IFREG). It is paid **only** on the rare `>KP_FS_CHUNK` read
  whose first chunk filled; ordinary small reads never reach it, and pipes are
  already handled by the SPSC fast path above (and fstat as non-regular anyway).
- The RO-`/usr` fast path above (`_roFd`) already filled the whole count in one
  local read — untouched. Only the brokered rw path was short-reading.

No mGBA / vendor edits. No unrelated kernel refactor. `compiler.js` untouched
(there was never a codegen defect).

## Regression test

`tests/kernel/test_read_fill_e2e.js` (registered in `tests/kernel/run.js` next
to `test_fs_e2e.js`). A real C guest over a kernel-owned BlockFS:

- writes a `4·CHUNK + 12345 = 252345`-byte regular file (spans 5 chunks), then
  does **one** `read(fd, buf, N)` and asserts `rv == N` **and** every byte
  matches a deterministic pattern (a fill bug that returned N but zero-tailed
  would still fail the byte check — mGBA's exact failure shape: `calloc` then
  one unlooped read).
- a partial read (buffer smaller than the file) fills the whole buffer.
- **scope proof:** a `pipe()` with 5 bytes written + write-end closed, read
  with a 4096 count, returns **5** (short) and does NOT loop/block — POSIX pipe
  short-read semantics preserved.

Verified it **FAILS** on pre-fix `kernel.js` (`rv=60000`, `badat=60000` — the
zero tail begins exactly at the first chunk boundary; partial read also 60000)
and **PASSES** after. The pipe leg passes in both (proves the fix didn't touch
non-regular semantics).

## Verification

- **New regression:** fails before / passes after (shown above).
- **Kernel gate** (`node tests/kernel/run.js`): **95 passed, 1 failed** — the
  one failure is `test_gucman_quake_e2e.js`, the known cold-bake window-wait
  flake (passes in isolation immediately after; its own assertion that the
  18.7 MB `pak0.pak` reads back **sha256-byte-exact through the pipeline** is
  incidental corroboration that the read-fill is correct at scale). No
  read-path suite regressed (fs/pipes/pty/sockets/tty/rofs/spsc all green).
- **mGBA end-to-end, real ROM, in-OS, mGBA source UNCHANGED** (Mario Tennis,
  16 MB, seeded via a temporary uncommitted `image.json` user entry + a
  gitignored `vendor/gameboy/roms/mariotennis.gba`, both reverted after):
  - `Jumped to invalid address` count: **0** (was 1,507,954)
  - DMA transfers: **1417** to VRAM/OAM/EWRAM (was 0) — the crt0 ran and the
    game is doing real graphics DMA off the now-fully-loaded ROM (sources
    `0x08…` = ROM)
  - `GBA core ready (MARIOTENNISA)`, log 86 KB (was tens of MB of flood)
  - Composited 480×320 frame: **88.2% non-white, 16 distinct color buckets**
    (the title / language-select screen) — refutes the 100%-white derail.

## Blast radius (for master's review)

The change is on the hot path of **every in-OS regular-file `read()`**. Behavior
change: a single large read of a regular file now returns up to `count`
(EOF-bounded) instead of ≤ 60000 B. This is strictly more POSIX/native-faithful
and is what callers that don't loop already assume; callers that DO loop see
fewer iterations, same bytes. Non-regular fds are byte-for-byte unchanged
(guarded by the S_IFREG fstat + the first-chunk-full gate). One extra `FS_FSTAT`
RPC per qualifying big read (rare). Do NOT merge/deploy without master's read of
the `kernel.js` diff — that's the handoff boundary for this branch.
