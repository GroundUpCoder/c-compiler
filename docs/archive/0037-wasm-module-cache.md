# 0037 — wasm module cache on the spawn path

- **Status**: done (2026-07-09) — dev log `logs/2026-07-09/module-cache.md`;
  design note in KERNEL.md ("The spawn path: compiled-Module cache").
  Key = fs `immutableKey` (mountPrefix:ino, non-null only on a READ-ONLY
  volume after full symlink resolution) — the plan's "system-volume
  binaries only" v1, made airtight by 0040's RO /usr: no generation to
  track, `cc -o a.out` stays bytes-path by construction. Cache values are
  Promises (racing spawns share one compile); ss-flavored/engine-rejected/
  unclonable modules are cached exclusions; a hit skips loadImage entirely
  and ships the Module instead of bytes. Measured (the plan's "measure
  before assuming"): per-spawn latency PARITY headless — V8's engine-wide
  NativeModule cache already deduped identical-bytes compiles, and ~27ms
  per spawn is worker-bootstrap-bound, not wasm — so the win is the
  engine-agnostic guarantee + zero per-spawn fs read/clone + the stats
  counter, at zero hot-path cost. `kernel.moduleCacheStats()` observable;
  tests `tests/kernel/test_module_cache.js` + `test_mounts.js`
  immutableKey legs; full kernel/blockfs/unit suites + the 10-file
  browser sweep green (which also covered the owed 0036 sweep).
- **Depends**: — (complements the unnumbered `tools/mkimage.js` item:
  that one kills cold-boot SEED cost, this kills per-spawn COMPILE cost)
- **Design**: `todos/KERNEL.md` (spawn path), host.js instantiation

## Goal

Stop recompiling `/bin/coreutils` (and every other binary) on every
spawn. Today each process worker reads the binary via RemoteFS and does
`new WebAssembly.Module(bytes)` fresh (host.js `_instantiate`) — every
`ls` in a pipeline pays a parse+compile of the full multicall binary,
and it grows with 0034/0035.

Note the terminology trap: **Instances can't be cached** — each process
needs its own memory and imports. What's cacheable is the compiled
`WebAssembly.Module`, which IS structured-cloneable over postMessage
(browser workers same-origin, and Node `worker_threads`) — compile once
kernel-side, hand the Module to the process worker in the spawn message.

## Plan

- Kernel-side cache: `Map` keyed by binary identity. **Resolve in-item**
  the invalidation key — inode id alone is unsafe (`cc -o a.out` reuses
  paths/inodes); needs a content generation (mtime+size, or a dirty tick
  bumped by FS_WRITE on that inode). Simplest safe v1: cache
  **system-volume binaries only** (post-0026 `/` is the immutable-
  between-reseeds volume; `/root` a.out-class binaries keep the compile-
  per-spawn path). Reseed/`--fresh-system` clears the cache.
- Thread the Module through spawn: kernel resolves+reads the binary at
  spawn time (it owns the fs already), compiles or cache-hits, ships the
  Module in the spawn message; process-worker/host.js accepts a
  pre-compiled Module as an alternative to bytes. Standalone (no-kernel)
  pages keep the bytes path unchanged.
- Fallback if Module cloning disappoints on some tier: cache bytes
  kernel-side + rely on the engine's own code cache — measure before
  assuming it helps.
- Bound the cache (LRU or just "system /bin only" — a dozen binaries).
- Measure: per-spawn latency for a coreutils pipeline
  (`ls | grep x | wc -l`) before/after, headless + browser.

## Acceptance

- Second and later spawns of the same /bin binary skip compilation
  (observable via the measured latency delta and/or a cache-hit counter
  in kernel stats).
- `cc hello.c -o hello && ./hello` still runs the NEW binary after a
  rebuild (invalidation/exclusion proves out).
- Full kernel + browser suites green; standalone host.js path untouched.
