# Coreutils: busybox applets as one multicall /bin binary (todos/0010)

The OS's userland grew up: `ls cp mv rm mkdir rmdir head tail wc sort pwd
true false ln touch basename dirname grep egrep fgrep sed cat echo printf
test [ kill` are now real busybox 1.37.0 applets. The `os/cat.c` /
`os/ls.c` stopgaps are deleted.

## The decision the item flagged: multicall won, by measurement

0010's sketch leaned per-applet builds (dodges upstream's kbuild-generated
applet tables, which 0005 deliberately stubbed). I built that first — 27
tiny bin.jsons over a shared `libbb-core.json` — and it *worked*, but
seeding measured **~26s** (each build re-parses the libbb.h/libc header
chain ~30×; no JIT-warmup amortization to speak of). Yesterday's
first-boot work got the browser boot to 2.3s; shipping a 10× regression
on it for architectural taste would have been silly.

So: **multicall**, but *our* multicall — `port/multicall_main.c` is a
hand-rolled name→main table for exactly the applets we ship, not
appletlib (the 0005 stubs stay; no generated headers). One ~2s build,
one 169KB wasm, `/bin/<name>` as BlockFS symlinks, dispatch on argv[0]
with a busybox-style `coreutils <applet>` fallback. The per-applet
scaffolding was deleted after the measurement, not kept as an option —
two build modes for the same applets would be maintenance theater.

Kept as-is: hush's NOMMU builtin-in-pipe re-exec of `/bin/sh` (0010 said
"revisit"). Revisited, kept: cost is one spawn either way, and the shell
shouldn't hard-depend on which image seeded it.

## What 27 applet symlinks flushed out (each its own small story)

- **`FS_READLINK` never worked.** kernel.js called BlockFS's
  buffer-style `readlink(path, buf, n)` as if it returned a string, and
  RemoteFS's readlink didn't mirror the BlockFS signature `toWasmEnv`
  expects. Invisible until now because *nothing had ever put a symlink
  through the brokered fs* — the first `ls -l /bin` EIO'd on every link.
  Both sides fixed (RPC carries the target as a string).
- **`BlockFS.open` ignored its create mode** — everything was born 0644.
  Now honored under a fixed 022 umask (single-user system; fopen's 0666
  still lands as 0644, and the e2e golden that encoded the old behavior
  agrees), so seeded binaries are 0755.
- **The Node-fs host env lacked the `link` import** (the BlockFS env had
  it) — `ln` in a standalone-compiled applet hit a LinkError.
- **libc gaps** (0005 found four; 0010 found six): `mkstemp` (sed -i),
  `strcasestr` (grep -i), `nlink_t`/`blkcnt_t`/`blksize_t` (ls),
  `AT_FDCWD`+`AT_SYMLINK_NOFOLLOW` (touch), chown-family as succeed
  no-ops, `mknod` as a failing stub. All in compiler.js's libc, not port
  patches — they're real POSIX surface.
- **`CONFIG_LONG_OPTS=y` is load-bearing**: off, `getopt32long` is a
  variadic macro and touch.c puts `#if` directives *inside the macro
  arguments* (C11 6.10.3p11 UB). As a real function it's a plain call and
  the `#if`s are fine. The compiler was right to reject it.
- **`FEATURE_LS_USERNAME` off on purpose**: it pulls libbb/procps.c +
  libpwdgrp to print "root" on a system where everyone is root.
- **sort -M**: this libc has no `strptime`; busybox only ever asks it for
  `"%b"`, so sort.c carries a 12-line month parser under `__wasm__`
  rather than the libc growing a strptime it can't do justice to.

## Infrastructure that fell out

- `os-common.js buildProject` learned bin.json **`deps`** (parity with
  the compiler CLI): `coreutils.json` and hush's `bin.json` share
  `libbb-core.json`.
- image manifests learned **`link` entries**; `image.json` is v7 with
  `/bin/coreutils` + 27 links.
- `tests/kernel/test_os_boot.js` grew a coreutils acceptance section
  (applet pipelines, cp/mv/rm/mkdir, sed|grep, the ls -l symlink render,
  the explicit `coreutils <applet>` form). `tests/browser/os-boots.mjs`
  types `ls -1 /` now — busybox ls prints columns on a tty, which is
  itself evidence the tty plumbing is honest.

Suites: unit 697 ✓, blockfs ✓, kernel (incl. OS acceptance) ✓, browser
os-boots ✓. Browser first boot now seeds hush + coreutils + cc — about
two seconds slower than yesterday's 2.3s; `tools/mkimage.js` remains the
recorded answer if that ever matters.
