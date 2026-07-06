# 0010 — busybox coreutils (multicall /bin binaries)

- **Status**: queued
- **Depends**: 0005 (hush + the vendor/busybox port infrastructure)
- **Design**: `todos/OS.md` (Phase 1 "Coreutils"); `vendor/busybox/README.md`

## Goal

A real userland: busybox applets (ls cat cp mv rm mkdir grep sed head tail
wc sort …) as `/bin` binaries, replacing the tiny native `os/cat.c` /
`os/ls.c` stopgaps. The 0005 port already vendors the applet framework's
libbb subset and compiles echo/printf/test/kill applet code as hush
builtins — this item widens that to a coreutils set.

## Plan sketch

- Decide multicall vs per-applet binaries. The classic multicall (one
  wasm, applet chosen by argv[0]) is the busybox way and keeps the image
  small; per-applet builds dodge the applet-table machinery
  (`appletlib.c`) that 0005 deliberately stubbed. Likely: per-applet
  bin.jsons sharing the vendored libbb (the stub keeps working), unless
  the applet table proves cheap to bring up.
- Extend `os/image.json` + seeding; hush's NOMMU builtin-in-pipe re-exec
  can then prefer real applets again (revisit the find_builtin patch).
- Watch for the libc gaps ports surface (0005 found four — expect more).

## Acceptance

- In the OS: `ls -l | grep … | wc -l` pipelines of real applets;
  `cp/mv/rm/mkdir` against BlockFS; `grep`/`sed` over files; the tiny
  cat.c/ls.c stopgaps deleted from os/.
