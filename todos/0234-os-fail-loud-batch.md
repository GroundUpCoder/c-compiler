# 0234 — gucOS fail-loud batch: registry hive, wm.c die(), config-store writes, spawn logging

- **Status**: open
- **Design**: —

## Goal

One-theme batch (fail-loud diagnostics in os/ runtime C, code-debt scan CD2/CD3/CD6/CD7):
a failure the user or a debugger can't see is a bug even when the code "handles" it.

## Plan

- **CD3 — advapi32.c registry writes silently lost.** `hive_save` returns void and
  swallows fopen/fprintf/fclose/rename failure; `hive_flush` clears `g_dirty` anyway,
  so winmine best-times / notepad settings vanish on EROFS or a full disk with no
  trace. Fix: `hive_save` returns int (ferror + fclose + rename all checked, tmp
  swept), `hive_flush` KEEPS `g_dirty` and reports once to stderr; NULL-check the
  malloc/strdup allocs (key_add, hive_load, RegSetValueExW).
- **CD6 — wm.c: 26 bare `exit(1)`s with zero diagnostic.** The desktop's central
  service dies silently (kernel-chrome fallback hides it); diagnosing a protocol
  drift means strace, not stderr. Fix: one `die(what)` helper (stderr: what +
  strerror(errno)) applied mechanically; stderr messages on main's early
  `return 1` subscribe paths too; wmp_read_all sets errno=ECONNRESET on EOF so
  the dominant "endpoint gone" case reads truthfully.
- **CD7 — config-store write API: four callers, three error disciplines.**
  ctlpanel Sounds checkbox checks + reverts (the correct pattern); ctlpanel
  Screen Saver radios/timeout and fileman's "Always" openwith checkbox ignore
  the return — on a read-only/full home they silently pretend success. Fix:
  apply the check → revert UI + MessageBox/strerror pattern at every write
  site (open.c's message gains strerror).
- **CD2 — spawn-failure LOGGING ONLY.** wm.c/fileman.c `spawn_path` have no else
  on posix_spawn failure — a double-click that fails to launch does NOTHING.
  Fix: report program + strerror(rc) to stderr. The launch-path DEDUP
  (spawn_path/reap_kids/activate into a shared header) is explicitly DEFERRED
  as a separate bigger item — not started here.

## Acceptance

- Image bake green (version bump — real runtime C changes), kernel suite green,
  browser sweep green.
- No compiler.js changes.
