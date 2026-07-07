# busybox — the shell port (todos/0005) + coreutils (todos/0010)

Two binaries come out of this vendor tree:

- **`bin.json`** → `/bin/sh`: hush, the shell (the 0005 port, below).
- **`coreutils.json`** → `/bin/coreutils`: a **multicall** binary carrying
  cat ls cp mv rm mkdir rmdir head tail wc sort pwd true false ln touch
  basename dirname grep egrep fgrep sed echo printf test `[` kill; the
  `/bin` applet names are BlockFS symlinks to it and dispatch is by
  argv[0] (`port/multicall_main.c` — a hand-rolled table, NOT upstream's
  kbuild-generated appletlib, so the 0005 appletlib stubs stay). Invoked
  under an unknown name it falls back to `coreutils <applet> …`,
  busybox-style. Both projects share `libbb-core.json` (the common libbb
  slice) via the bin.json `deps` mechanism.

  Why multicall and not per-applet builds: the OS compiles its userland
  from source at first boot (os/image.json), and 27 separate builds cost
  ~26s of seeding vs ~2s for this one binary — measured. Applet builds
  also get `-DPV_NO_INTERCEPT`: they never spawn, so the vfork journal
  interception (below) is compiled out and `vfork_spawn.c` isn't linked.

  hush's NOMMU builtin-in-pipe path still re-execs `/bin/sh` (see the
  find_builtin patch below) rather than the real applets: the cost is one
  spawn either way, and the shell stays correct even on an image that
  doesn't seed coreutils.

busybox 1.37.0's **hush** built as a standalone `/bin/sh` for the wasm OS
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
| `src/shell/hush.c` | 3 vfork sites → setjmp shim form (run_pipe, command substitution, heredoc); heredoc rewritten to bash-style unlinked temp file (a spawned pipe-feeder would deadlock: the consumer execs only after setup returns); `<fnmatch.h>` include made unconditional (its `ENABLE_HUSH_CASE` guard evaluates before autoconf.h is seen); backgrounded-stdin `/dev/null` journal-safe; NOMMU builtin dispatch uses the full builtin table (no multicall applet binary to re-exec, so builtins-in-pipes re-exec `/bin/sh` itself) |
| `src/include/platform.h` | includes `autoconf.h` (kbuild passes it via `-include`; this compiler has no such flag and platform.h is every TU's first header); `__wasm__` HAVE_* block (what this libc lacks — libbb/platform.c supplies fallbacks). (A former "ALIGN* emptied under `__wasm__`" patch was reverted 2026-07-07: the `aligned(N)` parser crash is fixed — `tests/unit/conformance/parse_attr_aligned_arg` — so upstream ALIGN* compiles as-is) |
| `src/include/libbb.h` | includes `wasm_port.h` at the end; `barrier()` empty under `__wasm__` (no inline asm; single thread); the three statement-expression ctype macros (isspace/isblank/iscntrl) → ALWAYS_INLINE helpers (no GNU statement exprs in this compiler) |
| `src/include/autoconf.h` | generated from `busybox.config` (allnoconfig + hush/editing/NOMMU); `CONFIG_BUSYBOX_EXEC_PATH` → `/bin/sh` (the re-exec-self image) |
| `src/libbb/xfuncs_printf.c` | unused syscall wrappers (xsocket/xbind/…/xmkstemp/xchroot/xsettimeofday, the NOEXEC vfork helper) guarded out under `__wasm__` |
| `src/coreutils/test.c` | `res = setjmp(leaving)` → supported if-form (every longjmp passes 2) |
| `src/coreutils/sort.c` | tiny local `strptime()` under `__wasm__` — this libc has none and `-M` only ever asks for `"%b"` |
| `src/procps/kill.c` | killall/killall5 branches guarded out (need /proc scanning) |
| `port/libbb_stubs.c` | appletlib globals (`applet_name` — overridable via `PORT_APPLET_NAME`, `xfunc_error_retval`, `bb_show_usage`, `string_array_len`), `bb_clk_tck`, single-user `bb_getgroups` |

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

## Known limitations

- Bare `$(trap)` (the POSIX save-traps idiom) doesn't report parent traps:
  the trap-hack child writes to a journaled (not yet real) fd. Niche;
  everything else about traps works.
- `PV_MAX_ACTIONS` (32) bounds redirects per command, `PV_MAX_SYNTH` (16)
  bounds concurrent never-exec'd pipe members. Both loud, both generous.
- Interactive line editing/job control need the tty bridge to declare
  `interactiveOut` (os.html does; piped CI runs stay byte-clean).
