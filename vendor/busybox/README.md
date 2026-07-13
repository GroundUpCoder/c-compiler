# busybox — the shell port (todos/0005) + coreutils (todos/0010, 0034, 0035, 0043)

Two binaries come out of this vendor tree:

- **`bin.json`** → `/bin/sh`: hush, the shell (the 0005 port, below).
- **`coreutils.json`** → `/bin/coreutils`: a **multicall** binary carrying
  cat ls cp mv rm mkdir rmdir head tail wc sort pwd true false ln touch
  basename dirname grep egrep fgrep sed **vi** echo printf test `[` kill
  (0010), plus — batch 2, todos/0034 — cut tr uniq tee nl od paste fold
  tac comm cmp du dd split truncate unlink readlink realpath mktemp stat
  sync yes seq env expr date uname usleep which cksum base64 md5sum
  sha1sum sha256sum; sleep, whoami, id and hostname are hand-rolled in
  `port/multicall_main.c` (sleep: upstream `sleep.c` wasn't vendored,
  added for todos/0014's harnesses; whoami/id/hostname: single-user stubs
  printing root/0/localhost rather than dragging in libpwdgrp — the
  `FEATURE_LS_USERNAME`-off philosophy); plus — batch 3, todos/0035, the
  SPAWN-CAPABLE set — **find xargs awk tar gzip gunzip zcat less diff**;
  plus — batch 4, todos/0043, the PROCESS TOOLS over the kernel's synthetic
  /proc — **ps top pgrep pkill uptime free** (upstream applets + libbb
  `procps.c`/`duration.c`/`getopt_allopts.c`; uptime/free go through the
  port's `sysinfo()` in libbb_stubs.c, which itself reads /proc). The
  `/bin` applet names are BlockFS symlinks to it and dispatch is by
  argv[0] (`port/multicall_main.c` — a hand-rolled table, NOT upstream's
  kbuild-generated appletlib, so the 0005 appletlib stubs stay). Invoked
  under an unknown name it falls back to `coreutils <applet> …`,
  busybox-style. Both projects share `libbb-core.json` (the common libbb
  slice) via the bin.json `deps` mechanism.

  Why multicall and not per-applet builds: the OS compiles its userland
  from source at first boot (os/image.json), and 27 separate builds cost
  ~26s of seeding vs ~2s for this one binary — measured.

  Since todos/0035 the multicall LINKS THE SHIM (`vfork_spawn.c` +
  `port/spawn_helpers.c` — libbb's spawn()/xspawn()/spawn_and_wait()
  hand-rolled over pv_*, replacing vfork_daemon_rexec.c which drags in
  the kbuild applet tables): find -exec and xargs journal their "vfork
  children" exactly like hush; awk's `cmd | getline` and `system()` go
  through libc popen/system (posix_spawn of /bin/sh); tar -cz spawns
  gzip via the patched `vfork_compressor`, tar -xz re-execs
  `gunzip -cf -` via the NOMMU `fork_transformer`, both landing on
  /bin symlinks back into this same binary. `pv_execve` also grew a
  BARE-EXEC emulation (exec outside any vfork child = spawn with an
  empty journal + wait + exit-with-child-status), so 0034's designed
  `env cmd` = 126 limit is gone — env execs for real. The former
  `-DPV_NO_INTERCEPT` applet-build define is history; only the port's
  own TUs (vfork_spawn.c, libbb_stubs.c, the two mains) still define it
  to reach the real functions.

  Config notes for batch 2: od is the non-DESKTOP od
  (BSD-style `-bcdox`, no GNU `-A/-t` — that's od_bloaty, DESKTOP-gated);
  `FEATURE_DATE_ISOFMT` stays OFF (needs a real strptime this libc
  doesn't have — see the date.c patch below); `FEATURE_STAT_FILESYSTEM`
  OFF (no statfs); `FEATURE_SYNC_FANCY` OFF (no syncfs);
  `FEATURE_DD_SIGNAL_HANDLING` OFF (status-on-SIGUSR1, not worth the
  signal surface); `CONFIG_UNAME_OSNAME="wasm"`. For batch 3 (0035):
  `FEATURE_ALLOW_EXEC=y` (without it awk's system() silently returns 0
  by upstream design); `USE_PORTABLE_CODE=y` (find.c's -exec argv is
  alloca, not a VLA — this compiler has no VLAs);
  `FEATURE_SEAMLESS_GZ=y` only (no xz/bz2/lzma/Z decompressors
  vendored); `FEATURE_TAR_TO_COMMAND` OFF (would spawn a shell per
  file; the OPT_2COMMAND block is #if-guarded out — see the patch
  table); `FEATURE_TAR_UNAME_GNAME` OFF (tar headers stamp root/root
  via libbb_stubs.c's get_cached_username/groupname, single-user);
  less has BRACKETS/FLAGS/TRUNCATE/MARKS/REGEXP/WINCH/LINENUMS/RAW on,
  ASK_TERMINAL/DASHCMD/ENV off. For batch 4 (0043): `PS`/`TOP`/`PGREP`/
  `PKILL`/`UPTIME`/`FREE` on with `FEATURE_PS_WIDE`, `FEATURE_PS_LONG`,
  `FEATURE_TOP_INTERACTIVE` (sort/quit keys over ptys) and
  `FEATURE_TOP_CPU_USAGE_PERCENTAGE`+`GLOBAL_PERCENTS` (the %CPU columns
  parse /proc/stat correctly but read ~0 by design — per-process CPU time
  isn't tracked, workers run on their own OS threads); `FEATURE_FAST_TOP`
  stays off (the sscanf parse path — no need for the speed hack),
  `FEATURE_TOPMEM`/`SHOW_THREADS` off (no smaps / no threads),
  `FEATURE_UPTIME_UTMP_SUPPORT` auto-off (FEATURE_UTMP off).

  hush's NOMMU builtin-in-pipe path still re-execs `/bin/sh` (see the
  find_builtin patch below) rather than the real applets: the cost is one
  spawn either way, and the shell stays correct even on an image that
  doesn't seed coreutils.

busybox 1.37.0's **hush** built as a standalone `/bin/sh` for gucOS
(`os/`). hush and not ash because this platform — like NOMMU Linux — has no
`fork()`: upstream ash hard-requires fork (`shell/ash.c` Kconfig:
`depends on !NOMMU`), while hush has lived on fork-less hardware for years
via **vfork + re-exec-self with serialized state** (`re_execute_shell`).
This port builds hush in its NOMMU configuration (`CONFIG_NOMMU=y` →
`BB_MMU 0`) and maps that machinery onto the OS's native
CreateProcess-class primitive, `__spawn` (decision: `todos/OS.md`).

## The vfork-on-__spawn shim (`port/vfork_spawn.c`, `port/include/wasm_port.h`)

There is no vfork either — but hush's NOMMU discipline makes every vfork
child a straight line of *journalable* operations (fd moves, pgroup calls,
then exec-or-_exit), and hush already restores its globals after the child
ran in shared memory. So the "child" simply **runs in the parent** in
journaling mode:

- The three vfork call sites are patched into the compiler-supported
  setjmp form: `if (setjmp(pv_state.jmp) == 0) { pv_child_begin(); <child
  code> }` … `pid = pv_state.child_pid;`
- While `in_child`, macros in `wasm_port.h` journal `close`/`dup2` into
  `__fd_action`s, real-`open` redirect targets (parent closes after
  spawn), `setpgid(0, pgrp)` into the spawn spec's `SETPGROUP`, defer
  `tcsetpgrp` until the pid exists, and swallow signal-disposition calls
  (a spawned process starts at SIG_DFL anyway).
- `exec*()` resolves the path (PATH search / cwd for relative), issues ONE
  `__spawn` with the journal, and longjmps back with the real pid.
- `_exit()` in a child that never execs (`var=x | cmd`, failed redirects)
  longjmps back with a **synthetic pid** whose wait status `waitpid()`
  serves from a small table.

## Patch sites (all marked `WASM PORT PATCH` in the source)

| File | Patch |
|---|---|
| `src/shell/hush.c` | 3 vfork sites → setjmp shim form (run_pipe, command substitution, heredoc); heredoc rewritten to bash-style unlinked temp file (a spawned pipe-feeder would deadlock: the consumer execs only after setup returns); `<fnmatch.h>` include made unconditional (its `ENABLE_HUSH_CASE` guard evaluates before autoconf.h is seen); backgrounded-stdin `/dev/null` journal-safe; NOMMU builtin dispatch uses the full builtin table (no multicall applet binary to re-exec, so builtins-in-pipes re-exec `/bin/sh` itself); `G.argv0_for_re_execing` strips a leading login-shell dash (todos/0177 — shells spawn as `-sh` per todos/0174, and without this every `$()`/pipe/builtin NOMMU re-exec inherits the dash, re-triggers login profile sourcing in the subshell, and a `$()` in a profile recurses forever / leaks profile stdout into substitutions) |
| `src/include/platform.h` | includes `autoconf.h` (kbuild passes it via `-include`; this compiler has no such flag and platform.h is every TU's first header); `__wasm__` HAVE_* block (what this libc lacks — libbb/platform.c supplies fallbacks). (A former "ALIGN* emptied under `__wasm__`" patch was reverted 2026-07-07: the `aligned(N)` parser crash is fixed — `tests/unit/conformance/parse_attr_aligned_arg` — so upstream ALIGN* compiles as-is) |
| `src/include/libbb.h` | includes `wasm_port.h` at the end; `barrier()` empty under `__wasm__` (no inline asm; single thread); the three statement-expression ctype macros (isspace/isblank/iscntrl) → ALWAYS_INLINE helpers (no GNU statement exprs in this compiler) |
| `src/include/autoconf.h` | generated from `busybox.config` (allnoconfig + hush/editing/NOMMU); `CONFIG_BUSYBOX_EXEC_PATH` → `/bin/sh` (the re-exec-self image) |
| `src/libbb/xfuncs_printf.c` | unused syscall wrappers (xsocket/xbind/…/xmkstemp/xchroot/xsettimeofday, the NOEXEC vfork helper) guarded out under `__wasm__` |
| `src/coreutils/test.c` | `res = setjmp(leaving)` → supported if-form (every longjmp passes 2) |
| `src/coreutils/sort.c` | tiny local `strptime()` under `__wasm__` — this libc has none and `-M` only ever asks for `"%b"` |
| `src/coreutils/date.c` | strptime branch (`-D`, ISOFMT-gated) wrapped in `#if ENABLE_FEATURE_DATE_ISOFMT` — implicit declarations are hard errors in this compiler, so upstream's if(0)-DCE idiom can't carry the undeclared strptime; ISOFMT stays off |
| `port/include/wasm_port.h` | (0035) the former `PV_NO_INTERCEPT` always-fail `execvp` stub is gone — both binaries link the shim now; `pv_execve` grew the bare-exec emulation (spawn with empty journal + wait + exit) for env-exec-class callers |
| `port/spawn_helpers.c` | (0035) libbb `spawn()`/`xspawn()`/`spawn_and_wait()` hand-rolled over the pv shim — upstream's vfork_daemon_rexec.c needs the kbuild applet tables this port replaced |
| `src/archival/tar.c` | (0035) `vfork_compressor`'s xvfork site → setjmp shim form; `execlp` → `execvp` (no execlp in this libc, the intercepts route execv*); `OPT_2COMMAND` block #if-guarded (address-taken `data_extract_to_command` survives if(0) DCE — only dead CALLS are dropped) |
| `src/archival/libarchive/open_transformer.c` | (0035) `fork_transformer`'s xvfork site → setjmp shim form (the journaled "child" re-execs `gunzip -cf -`, NOMMU-style) |
| `src/findutils/xargs.c` | (0035) `ISSPACE` statement expression → ALWAYS_INLINE helper (no GNU statement exprs; same rewrite as libbb.h's ctype trio) |
| `src/editors/awk.c` | (0035) F_rn: `#elif` branch composing 63 uniform bits from five 15-bit rand() draws — this libc's RAND_MAX is 32767, upstream only handles ≥31-bit |
| `src/miscutils/less.c` | (0035) three VLAs (`re_wrap` linebuf, `print_found`/`print_ascii` buf) → xmalloc/free (no VLAs in this compiler) |
| `src/editors/vi.c` | `sig = sigsetjmp(...); if (sig != 0)` → supported if-form (the value was only ever tested against 0); 6 GNU `?:` elvis sites → plain ternary (side-effect-free operands, this compiler has no `?:`) |
| `src/procps/kill.c` | killall/killall5 branches guarded out (predates 0043's /proc; un-guarding them is a possible follow-up now that procps_scan works) |
| `src/procps/ps.c` | (0043) the cmdline print buffer VLA → xmalloc/free (no VLAs in this compiler; same rewrite as less.c's three) |
| `src/procps/uptime.c`, `src/procps/free.c` | (0043) `<sys/sysinfo.h>` include gate widened to `__wasm__` (the port carries the header + a /proc-reading `sysinfo()` in libbb_stubs.c) |
| `src/libbb/procps.c` | (0043) uid/gid→name cache guarded out under `__wasm__` — it drags in libpwdgrp's uid2uname_utoa; libbb_stubs.c answers root/root without a cache (and stubs clear_username_cache) |
| `port/libbb_stubs.c` | appletlib globals (`applet_name` — overridable via `PORT_APPLET_NAME`, `xfunc_error_retval`, `bb_show_usage`, `string_array_len`), `bb_clk_tck`, single-user `bb_getgroups`; (0043) `sysinfo()` reading /proc/{uptime,loadavg,meminfo} with graceful zeros outside the OS, and the `clear_username_cache` no-op |

(`xfuncs_printf.c`'s former "xmkstemp guarded out" entry is gone: the libc
grew `mkstemp()` for `sed -i`, todos/0010.)

`busybox.config` records the exact configuration; regenerate `autoconf.h`
with busybox's kconfig if it changes (then re-apply the exec-path edit —
the NOMMU block is hand-patched in `autoconf.h` too, marked `WASM PORT`).
Config notes from 0010: `LONG_OPTS=y` is REQUIRED, not cosmetic — with it
off, `getopt32long` becomes a variadic macro and touch.c expands `#if`
directives inside the macro arguments (C11 6.10.3p11 UB this compiler
rejects). `FEATURE_LS_USERNAME` stays OFF: it drags in `libbb/procps.c` +
libpwdgrp to print "root" on a single-user system; ls -l shows numeric
0 0 instead.

## What the port surfaced elsewhere (fixed in-repo, not here)

From 0005 (hush):

- **Compiler**: void-pointer arithmetic compiled to `+0` (GNU
  `sizeof(void)==1`) — corrupted every hush word via libbb's `mempcpy`;
  fixed + `tests/unit/conformance/void_ptr_arith`.
- **libc**: `_exit()` was a spin-forever stub from the pre-kernel era — now
  does the `__exit` handshake (KERNEL.md exit design); `setpgid`/
  `getpgid`/`getpgrp` wrappers added over the existing kernel RPCs
  (which surfaced that the kernel's `_setpgid` had never been defined).
- **Kernel**: `interactiveOut` tty option — fd 1/2 become tty-kind under a
  human terminal so `isatty(1)` is true and shells go interactive.

From 0010 (coreutils):

- **libc additions**: `mkstemp()` (sed -i), `strcasestr()` (grep -i fast
  path), `nlink_t`/`blkcnt_t`/`blksize_t` (ls), `AT_FDCWD`/
  `AT_SYMLINK_NOFOLLOW` (touch); `chown`/`lchown`/`fchown` as succeed
  no-ops and `mknod` as a failing stub (single-user fs, no owner metadata,
  no device nodes).
- **host.js**: the Node-fs host env lacked the `link` import (BlockFS's
  had it); `BlockFS.open` now honors the caller's create mode under the
  system's fixed 022 umask — /bin binaries seed as 0755, fopen still
  lands 0644.
- **kernel.js**: `FS_READLINK` called BlockFS's buffer-style `readlink`
  string-style, and RemoteFS's didn't mirror the BlockFS signature that
  `toWasmEnv` expects — symlinks had simply never crossed the brokered fs
  before the applet links did (`ls -l /bin` EIO'd).
- **os/os-common.js**: `buildProject` learned bin.json `deps` (matching
  the compiler CLI), and image manifests learned `link` entries.

From 0011 (vi — dev logs `logs/2026-07-07/busybox-vi.md`,
`logs/2026-07-07/brokered-winsize.md`):

- **libc**: `sigjmp_buf`/`sigsetjmp`/`siglongjmp` added to `setjmp.h` — as
  macros over setjmp/longjmp (semantically correct here: signals are
  cooperative, there is no blocked-signal mask to save; macros so the
  compiler's setjmp lowering sees the plain `setjmp` call).
- **host.js**: `__ioctl_tiocgwinsz` guarded the winsize read on
  `_stdinSab`, which brokered-mode RemoteFS deliberately never sets (stdin
  is FS_READ RPCs; only `_stdinCtrl` — the tty SAB winsize words — is
  wired), so EVERY brokered process saw 80×24 forever; vi was the first
  program to ask. Same first-user-of-a-path class as 0010's FS_READLINK.
- **coreutils link**: vi pulls `read_key.c`/`safe_poll.c` (already
  vendored for hush) plus newly-vendored `read_printf.c`
  (`xmalloc_open_read_close`) into `coreutils.json`.

From 0034 (coreutils batch 2 — dev log
`logs/2026-07-08/coreutils-batch2.md`):

- **Compiler**: top-level parameter qualifiers participated in function
  type compatibility (C11 6.7.6.3p15 says drop them) — busybox stat.c's
  `print_it(print_stat)` was rejected; fixed +
  `tests/unit/conformance/fn_compat_param_quals`.
- **libc additions**: `clock_settime` (EPERM stub — the host owns the
  wall clock; date -s reports "can't set date"), `sync()` (no-op by
  design; per-fd durability is fsync), `getpagesize()` (64KiB — the wasm
  page), `mktemp`/`mkdtemp` (beside the existing mkstemp; the mktemp
  applet wants all three), `fseeko`/`ftello` (od's dump_skip),
  strftime `%z` (real offset from `tm_gmtoff`) and `%s` (epoch seconds —
  every script's `date +%s`).
- **host.js (plain Node-fs env)**: `write()` short-circuited fd 1/2 to
  the console BEFORE consulting the fd table, so split(1)'s
  `xmove_fd(xopen(part), 1)` wrote every part to the terminal and left
  the files empty — first program ever to dup2 a file over stdout in the
  standalone env (same first-user class as 0010's FS_READLINK).
  write/close/dup2 now route by the ENTRY's isStdin/isStdout/isStderr
  flags, the same pattern readImpl already used.
- New libbb files vendored: `hash_md5_sha.c`, `crc32.c`, `uuencode.c`,
  `dump.c` (od), `bb_bswap_64.c`, `executable.c` (which/env — now also
  in coreutils.json, not just hush's bin.json), `warn_ignoring_args.c`
  (sync).

From 0035 (spawn-capable applets — dev log
`logs/2026-07-09/spawn-applets.md`):

- **Compiler**: a declaration between `switch (...) {` and the first
  `case` label lost its wasm local (C11 6.8.4.2 keeps it in scope for
  the whole body; the initializer is legitimately skipped) — awk.c's
  `parse_expr` does exactly this; fixed +
  `tests/unit/conformance/switch_decl_before_case`.
- **libc addition**: `sched.h` with a no-op `sched_yield()` (less's
  non-blocking-stdin retry loop; single-threaded cooperative processes
  have nobody to yield to).
- **libbb_stubs.c** grew `get_cached_username`/`get_cached_groupname`
  single-user stubs (root/root — tar headers want them
  unconditionally).
- New libbb files vendored: `replace.c` (xargs -I), `isqrt.c` (awk) —
  plus the whole `src/archival/` + `src/archival/libarchive/` slice
  (tar/gzip/bbunzip + the transformer framework); `endofname.c` (awk)
  joins coreutils.json (it was hush-only).

## Known limitations

- Bare `$(trap)` (the POSIX save-traps idiom) doesn't report parent traps:
  the trap-hack child writes to a journaled (not yet real) fd. Niche;
  everything else about traps works.
- `PV_MAX_ACTIONS` (32) bounds redirects per command, `PV_MAX_SYNTH` (16)
  bounds concurrent never-exec'd pipe members. Both loud, both generous.
- Interactive line editing/job control need the tty bridge to declare
  `interactiveOut` (os.html does; piped CI runs stay byte-clean).
