# 0050 — pdpmake + busybox diff/patch

- **Status**: open
- **Design**: discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

Round out the in-OS dev environment: cc + **make** + vi + **diff** +
**patch**. pdpmake (Ron Yorston's public-domain POSIX make, written to
pair with busybox) becomes `/bin/make`; diff and patch join the
coreutils multicall. 0035's spawn-capable applets proved the exec seam
pdpmake needs (pdpmake runs recipe lines through the shell).

## Plan

- `vendor/pdpmake/`: small ANSI C codebase, its own bin.json. Command
  execution goes through the shell — patch its fork/exec (or system())
  sites onto `__spawn /bin/sh -c` like every other port; expected to be
  a handful of sites.
- `diff`, `patch` → `coreutils.json` batch (0034 pattern: verify config
  deps, image version bump, rebake).
- Seed `/bin/make`; update the seeded-binaries lists.

## Acceptance

- In-OS: a 3-file hello project with a Makefile builds via
  `make` + `/bin/cc` and runs; `make` again is a no-op; `touch` one TU
  → incremental rebuild recompiles only it; `make -n` prints without
  executing.
- `diff -u a b > d && patch a < d` round-trips in-OS.
- Headless kernel suite green; image bump verified.
