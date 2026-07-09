# todos/0037 — the compiled-Module cache on the spawn path

**What landed**: the kernel compiles each read-only-volume binary once and
ships the `WebAssembly.Module` in the spawn message; process workers
instantiate it instead of re-parsing bytes. `kernel.moduleCacheStats()`
counts. Design note in KERNEL.md ("The spawn path: compiled-Module cache").

## The mechanism

- **Key = fs `immutableKey(path)`** (host.js, BlockFS + MountFS):
  `mountPrefix:ino`, non-null only for a regular file whose owning volume —
  after full symlink resolution through the mount namespace — is mounted
  read-only. That sidesteps the whole invalidation problem the item flagged:
  RO contents can't change for the mount's lifetime, so there is no
  generation to track. `cc -o a.out` (rw volume) keys null and compiles per
  spawn forever; `/usr/local/...` escaping to the writable `/var/local` also
  keys null (the EROFS-after-walk ordering is what makes this correct — the
  owner volume decides). The inode dedupes the 75 coreutils applet symlinks
  into ONE cache entry.
- **The key is computed BEFORE `loadImage`, in the same synchronous turn**,
  so the identity stored is the identity the bytes were read under — no
  microtask window for a concurrent mutation to split them.
- **Cache values are Promises** (`WebAssembly.compile`), so racing spawns of
  one binary share a single compile. A Promise resolving null is a cached
  exclusion: ss-flavored modules (they must recompile from bytes with
  `importedStringConstants` in `runSsModule`), engine-rejected bytes (ship
  them; the worker owns the error report), and tiers where Modules don't
  structured-clone (one-shot `structuredClone` probe).
- **A hit does zero fs work**: `immutableKey`'s stat is the existence check,
  `loadImage` is skipped, and `procSpec.image` is null — the Module clone
  replaces the byte clone. Exactly one of `procSpec.image`/`procSpec.module`
  is non-null; `runModule({module})` skips its compile (compile options
  MUST MATCH between host.js runModule and kernel.js `_moduleFor`).

## The honest measurement

The item asked for a before/after spawn-latency delta on a coreutils
pipeline. Headless (Node 25, V8), 30 × `ls /bin | grep x | wc -l` = 90
spawns, boot cost subtracted:

|            | pipeline cost | per spawn |
|------------|---------------|-----------|
| before     | ~2.48 s       | ~27 ms    |
| after      | ~2.45 s       | ~27 ms    |

**Parity — and that's explained, not a failure.** Two findings:

1. **V8 already dedupes wasm compiles engine-wide.** Compiling the SAME
   bytes in a fresh worker is ~0 ms (the WasmEngine NativeModule cache is
   process-wide, shared across isolates). So on V8 — Node *and* Chromium —
   the "every `ls` re-parses the multicall" premise was already blunted at
   the engine level. The item's own fallback note ("rely on the engine's
   code cache — measure before assuming") was the right instinct.
2. **Per-spawn latency is worker-bootstrap-bound**: ~27 ms is thread/worker
   creation + host.js/kernel.js load, not wasm work. Our binaries are small
   (coreutils 0.37 MB, sqlite3 1.2 MB — this compiler emits compact wasm;
   first compile of the multicall is ~1 ms under Liftoff+lazy).

**Why land it anyway**: it makes the compile-once guarantee *architectural*
instead of a V8 implementation detail (JSC/SpiderMonkey have no such
promise), a hit skips the per-spawn BlockFS read + multi-MB clone (matters
more as binaries grow), tier-up state rides the shared NativeModule
deterministically, and the stats counter gives the spawn path observability
it had none of. Cost: ~40 lines in the kernel, zero on the hot path.
(Worker bootstrap cost — the actual per-spawn budget — is a separate,
now-visible follow-up; a worker pool would be the item.)

## Tests

- `tests/kernel/test_module_cache.js` (new, in run.js): part 1 drives cache
  policy over fake workers (RO hit/alias/stats, rw exclusion + rebuild
  freshness, ss exclusion cached, engine-rejected fallback, no-fs kernel
  untouched); part 2 runs real C through `worker_threads` proving the
  Module structured-clones via workerData and executes on miss and hit.
- `tests/kernel/test_mounts.js`: `immutableKey` semantics incl. the
  `/usr/local` → `/var/local` escape keying null.
- Suites: kernel (all pass, incl. os-boot/REPL/term/gpubox e2e), blockfs,
  unit (699 pass). Browser sweep re-run for this change (it also covers the
  0036 fsync change, whose sweep was owed).

## Gotchas for later

- `WebAssembly.Module` structured-clones through Node `workerData` and
  browser `postMessage` fine (verified Node 25 + Chromium) — but the kernel
  still probes once with `structuredClone` and falls back to bytes, so an
  exotic tier degrades instead of breaking spawn.
- If a THIRD compile-options flavor ever appears, `_moduleFor`'s options
  must stay in lockstep with runModule's (`builtins: ['js-string']`) — the
  MUST MATCH comment marks both ends.
- Image version NOT bumped: kernel.js/host.js are runtime, nothing baked
  into the blob changed.
