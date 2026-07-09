# Spawn-capable applets: the multicall learns to exec (todos/0035)

The shell-completeness batch: `find` (with -exec/-exec+), `xargs`, `awk`,
`tar`, `gzip`/`gunzip`/`zcat`, `less`, `diff` are real busybox 1.37.0
applets in `/bin/coreutils`. /bin is 75 multicall names; image is v30.

## The key unlock, as planned — and what it actually took

Dropping `-DPV_NO_INTERCEPT` and linking `port/vfork_spawn.c` into the
multicall worked exactly as 0034 predicted: applet TUs compile under the
intercept macros (pass-through outside journaling mode), and the vfork
call sites journal. What the plan didn't spell out:

- **libbb's `spawn()`/`xspawn()`/`spawn_and_wait()` couldn't come from
  upstream.** `vfork_daemon_rexec.c` includes `busybox.h` +
  `NUM_APPLETS.h` for its NOFORK/NOEXEC shortcuts — the kbuild applet
  machinery this port replaced with a hand-rolled table. New
  `port/spawn_helpers.c` spells the same semantics directly over the
  shim (setjmp form + `pv_execvp` + synthetic-pid failure path, so
  `spawn()` still returns -1 with errno when the image doesn't exist).
- **`pv_execve` grew a bare-exec emulation.** exec OUTSIDE a vfork child
  (env's `BB_EXECVP`) used to be ENOSYS — that was 0034's designed
  `env cmd` = 126 limit. Now it spawns with an EMPTY journal (fds, cwd,
  pgroup inherit), waits, and `_exit`s with the child's status
  (128+sig for signals). The lingering shell-of-a-parent is invisible
  to scripts. `env /bin/true; echo $?` is 0 — the old test leg asserting
  126 flipped.
- **tar -z, both directions, no piped fallback needed.** Create:
  `vfork_compressor`'s xvfork site → shim form (plus `execlp` →
  `execvp`; this libc has no execlp and the intercepts only route the
  execv* family). Extract: NOMMU `fork_transformer` re-execs
  `gunzip -cf -` — patched the same way; the re-exec'd binary is a /bin
  symlink back into the same multicall. The 0010-era "seamless .gz on
  NOMMU re-execs" story holds on this platform verbatim.

## The compiler bug of the round (every busybox batch finds one)

awk.c's `parse_expr`: `switch (tc) { var *v; case TC_VARIABLE: ... }` —
a declaration between `{` and the first case label. C11 6.8.4.2: the
declaration is never "executed" but is in scope for the whole body.
Our switch codegen emits case bodies starting at the first case's
statement position, so the preamble `SDecl` never allocated its wasm
local → `emitLValue: variable 'v' not found`. Fixed test-first
(`tests/unit/conformance/switch_decl_before_case`, e590dbd test,
e501702 fix): register REGISTER-class preamble decls up front,
initializers skipped (goto-past-declaration semantics); MEMORY-class
decls already worked via the frame-slot prepass, which does walk switch
bodies.

Also of the round:

- **libc addition**: `sched.h` with no-op `sched_yield()` — less calls
  it in its non-blocking-stdin retry loop. Single-threaded cooperative
  processes have nobody to yield to; blocking lives in kernel RPCs.
- **`FEATURE_ALLOW_EXEC` matters**: with it off (allnoconfig default),
  awk's `system()` compiles to `return 0` — silently. Cost an hour of
  staring at a working popen next to a "working" system() that ran
  nothing. It's =y now, recorded in busybox.config.
- **`USE_PORTABLE_CODE=y`**: find.c's -exec argv is a VLA otherwise
  (no VLAs in this compiler; the portable path is alloca). Three less.c
  VLAs (width-sized line buffers) were patched to xmalloc/free instead —
  width is screen-resize-driven and unbounded, a fixed buffer would lie.
- **awk rand()**: upstream #errors below 31-bit RAND_MAX; ours is 32767.
  New #elif composes 63 bits from five 15-bit draws.
- **tar --to-command stayed off** and its `OPT_2COMMAND` block is
  #if-guarded out: the feature-off constant makes the block dead, but
  the ADDRESS-TAKEN `data_extract_to_command` survives if(0) DCE —
  this compiler only drops dead calls (same class as 0034's date.c
  strptime note, one level up: declared-but-undefined function
  references die in dead CALLS, not in dead function-pointer stores).
- **Single-user stubs again**: tar create stamps uname/gname
  unconditionally → `get_cached_username`/`groupname` return root/root
  from libbb_stubs.c rather than dragging in libpwdgrp.

## Tests

- `test_os_boot.js` "coreutils batch 3" session: find -name/-exec/xargs
  pipelines, awk `$NF` / `cmd | getline` / `system()`, tar cf/tf/xf +
  czf/xzf roundtrips with content compares, the piped
  `tar cf - | gzip | gunzip | tar tf -` form, gzip -k + zcat + cmp,
  diff exit codes + hunk body. The 0034 `env-exec=126` leg is now
  `env-exec=0` (the limit it documented is gone by design).
- `test_term_e2e.js` session D: less inside the wasm terminal over the
  real pty — alt screen renders the file (pixel-count assert on the
  shot, status row present), space pages, `q` hands the keyboard back
  to hush (rc-file echo runs, rc=0).
- Suites at landing: unit (699) ✓, blockfs ✓, kernel ✓, full browser
  sweep ✓ (serial; the codegen fix rebakes every binary, so all ten
  os-*.mjs ran).

## Gotchas for the next round

- Editing `busybox.config` still means: /tmp/busybox-1.37.0 kconfig
  (`conf -o` + `conf -s`), then re-apply the TWO hand patches to
  autoconf.h (exec-path "/bin/sh", the NOMMU comment) — both marked
  WASM PORT. The 0035 flips are recorded in the vendored
  busybox.config.
- The multicall grew 271 → 392 KiB for the nine applets. Still
  near-free vs per-applet builds.
- patch/ed were deliberately NOT vendored (0050's pdpmake orbit wants
  patch; diff landed here).
