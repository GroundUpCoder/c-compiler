# 0043 — procfs + the process-tools applet batch

- **Status**: done (2026-07-09) — ProcFS in kernel.js (synthetic MountFS
  volume, Kernel-ctor auto-bind), mounted in both embedders; busybox
  ps/top/pgrep/pkill/uptime/free as coreutils batch 4 (+ libc getsid via
  OP.GETSID, port sysinfo()); image v32; tests
  `tests/kernel/test_procfs.js` + test_os_boot.js procps legs; dev log
  `logs/2026-07-09/procfs.md`
- **Depends**: —
- **Design**: `todos/KERNEL.md` (process table + the landed "/proc"
  section), discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

A synthetic `/proc` served by the kernel through MountFS, with
Linux-compatible file formats, so busybox `ps`/`top`/`pgrep`/`pkill`/
`uptime`/`free` work unmodified.

## Plan

- A **synthetic volume** object implementing the fs-op surface MountFS
  routes to (open/read/stat/readdir/close); content generated at open
  (snapshot semantics, like Linux); read-only; no BlockFS backing, no
  on-disk format change (fsck untouched). Mounted at `/proc` in both
  embedders (kernel-worker + boot.js).
- Files: `/proc/<pid>/{stat,status,cmdline,comm}`, `/proc/uptime`,
  `/proc/meminfo`, `/proc/stat`, `/proc/version`. Emit Linux formats so
  busybox parses them as-is. Per-process CPU time is not tracked
  (workers run on their own threads) — report zeros; `top`'s CPU column
  is boring by design, documented.
- Applet batch (0034 pattern): ps top pgrep pkill uptime free into
  `coreutils.json`; verify config deps; image version bump + rebake.

## Acceptance

- Headless: `echo 'ps' | node os/boot.js` lists pid 1 and the ps
  process; `readdir /proc` gains/loses numeric pids across spawn/exit.
- `pkill` by name terminates a background job; `pgrep` finds it first.
- `cat /proc/<pid>/status` agrees with the kernel process table
  (state, ppid, pgid).
- Kernel suite green; blockfs suite untouched.
