# 0097 — ss modules join the spawn module cache (0037) — compile options unified by 0041

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/SS-INTEROP.md` §4 "Compile options unify → ss joins the
  module cache" (this item is that section's residue, unblocked by 0041).

## Goal

Cache-compile ss-flavored binaries in `kernel._moduleFor` exactly like C
ones. They were excluded from the 0037 spawn module cache only because their
compile options differed (`importedStringConstants: '#'`); 0041 added that
option to the C path too (host.js `runModule` + kernel.js `_moduleFor`, the
MUST-MATCH pair), so the exclusion's reason is gone — today every ss spawn
still recompiles from bytes.

Sequenced after 0079 (project-dep-dedup) purely as neighboring
infra-cleanup work; no hard dependency.

## Plan

- kernel.js `_moduleFor`: drop the `imports 'ss'` → cached-null branch;
  probe structured-clone as for C modules.
- host.js `runModule`: accept a precompiled Module for the ss flavor —
  `runSsModule` today requires bytes and recompiles; give it a `module`
  option and keep the bytes fallback for direct callers.
- Update the "ss-flavored modules are excluded" comments in both files and
  the runModule flavor-dispatch note (host.js ~8544).
- `tests/kernel/test_module_cache.js`: flip the ss expectation — the
  ss-flavored fixture should now HIT the cache; keep a bytes-path leg for
  no-fs kernels.

## Acceptance

- Spawning the same read-only-volume ss binary twice compiles once
  (`kernel.moduleCacheStats()`), runs correctly both times.
- Kernel suite green; no C-path behavior change.
