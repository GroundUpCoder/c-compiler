# 0034 — coreutils batch 2: the trivial applets

- **Status**: done (2026-07-08) — dev log `logs/2026-07-08/coreutils-batch2.md`.
  37 applets landed (all targets; whoami/id/hostname as hand-rolled
  stubs per plan; env can't exec until 0035 — always-fail execvp seam
  in wasm_port.h). Surfaced: the fn-type param-qualifier conformance
  bug (`fn_compat_param_quals`), the standalone-host dup2-over-stdout
  hole (split), and 7 libc additions (clock_settime, sync, getpagesize,
  mktemp/mkdtemp, fseeko/ftello, strftime %z/%s). Image v28.
- **Depends**: —
- **Design**: `vendor/busybox/README.md` (multicall mechanics, config
  gotchas), `logs/2026-07-07/coreutils-multicall.md`

## Goal

Fill out the everyday-shell gaps with the pure-filter / stat-caller
busybox applets — the ones that need no fork, no /proc, no network. Each
is: vendor the upstream `.c` (1.37.0 tarball), add to `coreutils.json`,
one entry in `port/multicall_main.c`'s hand-rolled table, one `link`
entry in `os/image.json`.

Target list (trim/extend as the vendoring goes):

- Text filters: `cut tr uniq tee nl od paste fold tac comm`
- Files/fs: `cmp du dd split truncate unlink readlink realpath mktemp
  stat sync`
- Misc: `yes seq env expr date uname usleep which cksum base64`
- Hashes: `md5sum sha1sum sha256sum` (one extra libbb file,
  `libbb/hash_md5_sha.c`)
- Single-user stubs: `whoami id hostname` (print root/0/localhost —
  match the `FEATURE_LS_USERNAME`-off philosophy)

## Plan

- Batch the vendoring but keep applets independent — land in a few
  commits if some hit libc gaps (surfacing those is half the value of
  every busybox round; see the 0010/0011 "what the port surfaced" lists).
- All of these keep `-DPV_NO_INTERCEPT` — none spawn. Spawning applets
  (find/xargs/awk/tar) are **0035**, deliberately split out.
- Watch the recorded config gotchas: `LONG_OPTS=y` stays required;
  new `FEATURE_*` knobs go into `autoconf.h` (marked `WASM PORT` if
  hand-patched); prefer features OFF unless needed.
- `os/image.json`: one symlink per applet name, ONE version bump for the
  batch.
- Update `vendor/busybox/README.md`'s applet list + any new patch-table
  rows.

## Acceptance

- Each new applet smoke-tested through headless boot
  (`echo '...' | node os/boot.js`) — a representative pipeline per
  applet class (e.g. `seq 3 | tac`, `echo x | md5sum`, `stat /bin/sh`).
- A `tests/kernel/test_os_apps_e2e.js`-style leg (or extension) covering
  a handful, so regressions are caught without manual runs.
- Fresh-seed cost stays in the same ballpark (multicall additions are
  near-free — that's the point of the single binary).
