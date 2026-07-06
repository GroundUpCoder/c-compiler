# busybox hush — the shell port (todos/0005)

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
| `src/include/platform.h` | includes `autoconf.h` (kbuild passes it via `-include`; this compiler has no such flag and platform.h is every TU's first header); `__wasm__` ALIGN* macros emptied (compiler bug with `aligned()` after array declarators); `__wasm__` HAVE_* block (what this libc lacks — libbb/platform.c supplies fallbacks) |
| `src/include/libbb.h` | includes `wasm_port.h` at the end; `barrier()` empty under `__wasm__` (no inline asm; single thread); the three statement-expression ctype macros (isspace/isblank/iscntrl) → ALWAYS_INLINE helpers (no GNU statement exprs in this compiler) |
| `src/include/autoconf.h` | generated from `busybox.config` (allnoconfig + hush/editing/NOMMU); `CONFIG_BUSYBOX_EXEC_PATH` → `/bin/sh` (the re-exec-self image) |
| `src/libbb/xfuncs_printf.c` | unused syscall wrappers (xsocket/xbind/…/xmkstemp/xchroot/xsettimeofday, the NOEXEC vfork helper) guarded out under `__wasm__` |
| `src/coreutils/test.c` | `res = setjmp(leaving)` → supported if-form (every longjmp passes 2) |
| `src/procps/kill.c` | killall/killall5 branches guarded out (need /proc scanning) |
| `port/libbb_stubs.c` | appletlib globals (`applet_name`, `xfunc_error_retval`, `bb_show_usage`, `string_array_len`), `bb_clk_tck`, single-user `bb_getgroups` |

`busybox.config` records the exact configuration; regenerate `autoconf.h`
with busybox's kconfig if it changes (then re-apply the exec-path edit).

## What the port surfaced elsewhere (fixed in-repo, not here)

- **Compiler**: void-pointer arithmetic compiled to `+0` (GNU
  `sizeof(void)==1`) — corrupted every hush word via libbb's `mempcpy`;
  fixed + `tests/unit/conformance/void_ptr_arith`.
- **libc**: `_exit()` was a spin-forever stub from the pre-kernel era — now
  does the `__exit` handshake (KERNEL.md exit design); `setpgid`/
  `getpgid`/`getpgrp` wrappers added over the existing kernel RPCs
  (which surfaced that the kernel's `_setpgid` had never been defined).
- **Kernel**: `interactiveOut` tty option — fd 1/2 become tty-kind under a
  human terminal so `isatty(1)` is true and shells go interactive.

## Known limitations

- Bare `$(trap)` (the POSIX save-traps idiom) doesn't report parent traps:
  the trap-hack child writes to a journaled (not yet real) fd. Niche;
  everything else about traps works.
- `PV_MAX_ACTIONS` (32) bounds redirects per command, `PV_MAX_SYNTH` (16)
  bounds concurrent never-exec'd pipe members. Both loud, both generous.
- Interactive line editing/job control need the tty bridge to declare
  `interactiveOut` (os.html does; piped CI runs stay byte-clean).
