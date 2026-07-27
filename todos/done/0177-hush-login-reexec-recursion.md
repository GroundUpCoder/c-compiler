# 0177 — hush: $() subshells re-exec as login shells — .profile recursion hang + substitution pollution

- **Status**: done
- **Design**: —

## Goal

Fix the login-shell recursion in hush's NOMMU re-exec path. Since todos/0174
spawns shells as login shells (`argv[0] = "-sh"`), EVERY command substitution
(and every NOMMU pipe/builtin re-exec) inherits the dash: `re_execute_shell`
passes `G.argv0_for_re_execing` (= the parent's raw `argv[0]`, stock upstream
code at hush.c:10401) as the child's argv[0], and hush_main's login detection
is just `argv[0][0] == '-'` — with profile sourcing happening BEFORE `-c` is
processed ("-c takes effect *after* -l"). Consequences, both verified by repro:

1. **Hang**: a `$(...)` anywhere in `~/.profile` (or /etc/profile) recurses —
   pid 1 sources .profile → the $() re-execs a "login" subshell → it sources
   .profile → ... Infinite serial spawn chain; boot never reaches the prompt.
   Repro: `.profile` containing `M=$(echo m)` → boot.js produces zero output.
2. **Substitution pollution**: profile stdout leaks into every substitution
   result. Repro: `.profile` = `echo PROFILE_RAN`, then
   `echo A $(echo hi) B` → `A PROFILE_RAN hi B`.

This is a latent UPSTREAM busybox NOMMU bug (any NOMMU login hush has it);
0174 exposed it here. It is NOT an architecture problem — the vfork-journal /
__spawn / re-exec-self machinery, pipe EOF and waitpid all check out (40
back-to-back substitutions clean). The bug is state over-propagation: the
re-exec'd child must reconstruct exactly the state fork() would have copied,
and "is a login shell being invoked" is invocation context, not shell state.

## Plan

One-line WASM PORT PATCH at the `G.argv0_for_re_execing = argv[0];` site
(hush.c:10401): strip a leading dash —

```c
G.argv0_for_re_execing = (argv[0] && argv[0][0] == '-') ? argv[0] + 1 : argv[0];
```

`$0` in the child is unaffected (passed separately as `g_argv0` =
`G.global_argv[0]`); the re-exec always execve's `CONFIG_BUSYBOX_EXEC_PATH`
(/bin/sh), so argv[0] only feeds login detection. Add the patch to
vendor/busybox/README.md's hush.c patch-table row. Bump image.json version.
Consider reporting upstream.

Validated in a scratch worktree (2026-07-13): with the patch, the previously
hanging `.profile` (`M=$(echo m); echo PROFILE_DONE $M`) prints
`PROFILE_DONE m` at boot, `echo A $(echo hi) B` → `A hi B` (no leakage),
prompt reached.

## Acceptance

- Boot with `~/.profile` containing `X=$(echo m)` reaches the prompt; the
  profile line evaluates (X=m).
- `.profile` printing to stdout does not alter `$(...)` results.
- A kernel-suite e2e covering both (login-shell boot + $() in .profile +
  substitution purity) — the 0174 login-sourcing test file is the natural
  home.
- Existing hush/coreutils e2es stay green (`node tests/run.js --diff`).
