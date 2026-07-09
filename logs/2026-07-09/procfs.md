# procfs + the process-tools applet batch (todos/0043)

Landed: a synthetic `/proc` served by the kernel through MountFS, in
Linux-compatible file formats, plus busybox coreutils batch 4 — **ps top
pgrep pkill uptime free** — parsing it unmodified.

## Shape: a volume, not a special case

`ProcFS` (kernel.js) implements exactly the fs-op surface MountFS routes
to (open/read/stat/opendir/readdir/…) and nothing else. That was the
whole design bet of 0026/0040: the kernel funnels every process fs access
through one method surface, so "mount a process table" is just another
volume — zero changes to MountFS, RemoteFS, the fd layer, or fsck (there
is no on-disk format). The embedders each changed by one line
(`'/proc': new ProcFS()` in their mount tables); the Kernel constructor
scans the mounts and binds itself, so there's no wiring to forget.
MountFS's constructor already materializes mount-point directories on the
volume underneath, which is why existing root images grow `/proc` on next
boot with no reseed and no version gate.

Decisions that mattered:

- **Snapshot at open**, like Linux: open() renders the whole file;
  reads work the buffer. busybox's `read_to_buf` does one big read and
  the host-side `readFileBytes` sizes via fstat — so unlike Linux our
  procfs reports REAL sizes (harmless, and `cp /proc/... x` works).
- **Zombies stay listed until reaped** (like Linux), with empty cmdline —
  busybox's `read_cmdline` then shows `[comm]`, exactly the upstream UX.
- **State is real**: R running, S = parked in a blocking RPC (the waiter
  field — a genuinely faithful mapping for this kernel), T stopped,
  Z zombie.
- **What's synthetic is documented, not hidden**: utime/stime are 0
  (workers run on their own OS threads; nobody accounts their CPU), so
  top's %CPU column is boring *by design*; VmSize/VmRSS are nominal
  constants; meminfo is a fixed plausible table — MemTotal MUST stay
  nonzero because top divides by it. loadavg's running/total counts and
  last-pid are real, derived from the process table.
- **No `/proc/self`**: fs ops carry a path, not a caller pid — the fd
  layer has no per-request process identity, and nothing shipped needs it
  (`CONFIG_BUSYBOX_EXEC_PATH` was already hand-patched to `/bin/sh`).
- The pcb grew `path`/`argv`/`startMs`; the kernel grew `_bootMs`.
  start_time (stat field 22, jiffies since boot at HZ=100 — matching the
  port's `bb_clk_tck()`), `/proc/uptime`, and `/proc/stat`'s accruing
  idle counter all derive from those, so `ps -l`'s ELAPSED/STIME math
  works out.

## The applet batch (busybox coreutils batch 4)

The procps sources were NOT yet vendored (only `kill.c` was). Vendored
from the upstream 1.37.0 tree: `procps/{ps,top,pgrep,uptime,free}.c` +
`libbb/{procps,duration,getopt_allopts}.c`. Port patches (all marked
`WASM PORT PATCH`, table updated in `vendor/busybox/README.md`):

- `ps.c`: the cmdline print buffer was a VLA — xmalloc/free, the same
  rewrite as less.c's three.
- `libbb/procps.c`: the uid→name cache guarded out under `__wasm__` — it
  drags in libpwdgrp; libbb_stubs.c answers root/root without a cache and
  stubs `clear_username_cache`.
- `uptime.c`/`free.c`: `<sys/sysinfo.h>` include gate widened to
  `__wasm__`. The port carries the header (`port/include/sys/sysinfo.h`)
  and a `sysinfo()` in libbb_stubs.c that reads /proc/{uptime,loadavg,
  meminfo} — procfs knowledge stays in the busybox port, not libc; it
  reports zeros gracefully outside the OS (standalone runs).

Config: `PS/TOP/PGREP/PKILL/UPTIME/FREE` on, with `FEATURE_PS_WIDE/LONG`,
`FEATURE_TOP_INTERACTIVE`, `FEATURE_TOP_CPU_USAGE_PERCENTAGE` +
`GLOBAL_PERCENTS`; `FEATURE_FAST_TOP`/`TOPMEM`/`SHOW_THREADS` off.
autoconf.h regenerated via the /tmp/busybox-1.37.0 kconfig (`conf -o` +
`conf -s`), both hand-patches re-applied — the diff was verified to be
exactly the expected flag flips.

One real libc addition: **getsid()** (`__spawn_getsid` → new `OP.GETSID`
0x000A → pcb.sid), because pgrep's `-s 0` resolves its own session. Same
5-seam plumbing as 0005's getpgid.

`kill.c`'s killall/killall5 guards predate working /proc scanning —
un-guarding them is a cheap follow-up now (noted in the README patch
table), left out of 0043's scope.

## Image

v31 → **v32** (new symlinks ps/top/pgrep/pkill/uptime/free + coreutils
content change + the libc change rebaking everything);
`os/os-system.img` re-baked via mkimage.

## Verification

- New `tests/kernel/test_procfs.js` (47 checks): formats, snapshot-at-
  open, zombie lifecycle, EROFS/EACCES, FS RPC transport legs
  (chdir /proc → relative opendir/open/read, what top actually does),
  GETSID, unbound-ProcFS safety.
- `test_os_boot.js` grew a procps section: ps lists pid 1 + itself,
  pgrep→pkill on a background sleep (wait status 143), /proc/1/status
  agreement, uptime/free/top parsing; `ls /` golden gained `proc`.
- Suites: kernel, blockfs, unit (699), plus the full 10-file browser
  sweep (kernel.js + image-rebaking changes ⇒ sweep owed).
