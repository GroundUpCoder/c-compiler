# Coreutils batch 2: 37 more applets in the multicall (todos/0034)

The everyday-shell gaps are filled: `cut tr uniq tee nl od paste fold tac
comm cmp du dd split truncate unlink readlink realpath mktemp stat sync
yes seq env expr date uname usleep which cksum base64 md5sum sha1sum
sha256sum` are real busybox 1.37.0 applets now, plus hand-rolled
`whoami`/`id`/`hostname` single-user stubs (root/0/localhost — printing
the only possible answer beats vendoring libpwdgrp, same reasoning as
`FEATURE_LS_USERNAME` off). /bin has 66 multicall names; image is v28.

Config went through the recorded kconfig route (the 0010 leftovers in
/tmp still had the built `conf` binary): flip 42 symbols in `.config`,
`conf -o` + `conf -s`, re-apply the two WASM PORT hand-patches to
autoconf.h. Deliberate OFFs: `FEATURE_STAT_FILESYSTEM` (no statfs),
`FEATURE_SYNC_FANCY` (no syncfs), `FEATURE_DD_SIGNAL_HANDLING`,
`FEATURE_DATE_ISOFMT` (below). od is the non-DESKTOP od — BSD flags
only; GNU `-A/-t` is od_bloaty, which DESKTOP=n keeps out.

## What 37 applets flushed out (the real value of every busybox round)

- **Compiler conformance bug**: top-level parameter qualifiers
  participated in function type compatibility — stat.c's
  `print_it(format, file, print_stat, …)` was rejected because
  `print_stat` declares `const char m, const char *const filename` and
  the function-pointer parameter spells them unqualified. C11 6.7.6.3p15
  says compatibility is judged on the UNQUALIFIED parameter types.
  Test-first: `tests/unit/conformance/fn_compat_param_quals` (also
  covers the differently-qualified redeclaration case), then a one-line
  fix in `FunctionType._eqStructure` (top-level `removeQualifiers()` on
  each side — pointee qualifiers still count).
- **host.js standalone Node-fs env: dup2-over-stdout never worked.**
  split(1) re-points fd 1 at each output part (`xmove_fd(xopen(pfx), 1)`)
  and `write()` short-circuited fd 1/2 to the console BEFORE consulting
  the fd table — every part landed on the terminal and the files stayed
  empty. Nothing had ever dup2'd a file over stdout in the standalone
  env (the BlockFS env handles it; readImpl's `isStdin` check was
  already the right pattern). write/close/dup2 now route by the entry's
  `isStdin/isStdout/isStderr` flags — `2>&1`-style aliases of the
  default entries still hit the console, dup2'd file entries hit the
  file, and the per-part native-fd leak in dup2's close-of-newfd path is
  gone. Same first-user-of-a-path class as 0010's FS_READLINK and
  0011's brokered winsize.
- **libc additions** (real POSIX surface, not port patches):
  `clock_settime` EPERM stub (the host owns the wall clock — `date -s`
  says "can't set date", which is the truth), `sync()` no-op by design
  (writes reach the store as they happen; per-fd durability is fsync),
  `getpagesize()` = 64KiB (the wasm page), `mktemp`/`mkdtemp` beside
  mkstemp (busybox's mktemp applet wants all three; shared XXXXXX spin),
  `fseeko`/`ftello` (od's dump_skip; off_t-wide like fgetpos/fsetpos),
  strftime `%z` (from `tm_gmtoff` — localtime DOES apply the host tz
  here, so the old "+0000 always" assumption was wrong) and `%s`
  (`date +%s` — every script wants it; verified against host `date -j`).
- **date.c patch** (WASM PORT, in the table): the ISOFMT strptime branch
  is preprocessor-guarded out. Upstream relies on `if (ENABLE_X)` DCE,
  which works here for *undefined* functions but not *undeclared* ones —
  implicit declarations are hard errors. ISOFMT stays off; sort.c's
  local `"%b"` strptime remains the only strptime in the tree.
- **env can't exec, on purpose**: the multicall is `-DPV_NO_INTERCEPT`
  (never spawns) and the libc has no exec*. `wasm_port.h`'s no-intercept
  branch grew an always-fail execvp (ENOSYS) so BB_EXECVP_or_die links;
  `env cmd` exits 126 "Function not implemented", bare `env` works.
  Spawn-capable applets (find/xargs/awk/tar, env-exec) are 0035's
  problem, deliberately.

## Notes

- New libbb files: hash_md5_sha, crc32, uuencode, dump (od),
  bb_bswap_64, warn_ignoring_args; executable.c joins coreutils.json
  (which/env) — it was hush-only before.
- `yes | head -2` in-OS terminates via kernel-pipe EPIPE, and is now a
  test leg. The STANDALONE Node bundle host instead buffers a
  closed-stdout writer into an OOM (`node cu.js yes | head` — writer
  never sees EPIPE). Pre-existing standalone-host behavior, not this
  batch's; noting it here so nobody re-discovers it the hard way.
- libc realpath doesn't resolve symlinks (returns the normalized path;
  `realpath lnk` prints the link's own path, GNU prints the target's).
  Pre-existing; surfaced by the realpath/readlink -f applets. Worth its
  own small item if it ever bites a port.
- `date -u` is display-only-wrong: busybox implements -u by `putenv(TZ)`
  which this libc ignores; `%s`/epoch math is unaffected.
- Fresh headless bake+seed ≈ 8s wall; the multicall wasm grew 220 → 271
  KiB for the 37 applets. Multicall additions stay near-free, as
  intended.
- Test legs: `tests/kernel/test_os_boot.js` grew a "batch 2" session —
  one leg per applet class, goldens taken from a real boot and
  cross-checked (md5/cksum against host tools).

Suites at landing: unit (698) ✓, blockfs ✓, kernel ✓, browser sweep ✓
(serial, per convention — os/ and host.js were touched).
