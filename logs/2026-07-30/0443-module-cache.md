# #188 (0443) — module cache for rw-volume binaries: the validated moduleKey

Lane 0443, 2026-07-30, branch `0443-module-cache`. Ticket `#188` (P0), parent
`todos/0385` (the measurement that found this), sequenced before `todos/0444`
(the launcher-chain half of the same latency budget).

## What landed

The 0037 compiled-Module spawn cache excluded every writable-volume binary:
`immutableKey` returned null off a read-only volume, so a gucman-installed
`/opt` binary compiled a fresh `WebAssembly.Module` on EVERY spawn. On JSC the
engine's JIT state follows the Module object, so a fresh Module means the
binary's whole init runs interpreted-cold each time — the ~200 ms/spawn cliff
0385 measured, and the bulk of iPhone `python --version` taking ~2 s. The
RO-only policy was a special-case-the-easy-path artifact ("no invalidation to
get wrong"), and the ticket's ruling was the general fix, not a second special
case.

`immutableKey` is now **`moduleKey`** (host.js, BlockFS + MountFS; one shared
`moduleKeyOf` derivation so the two spellings cannot drift):

- **read-only volume** → `prefix:ino`, exactly the 0037 key, key-for-key.
  Immutability subsumes validation; nothing changed on this path (acceptance
  arm 3), and the applet-symlink dedup story is untouched.
- **writable volume** → `prefix:ino:size:mtime.nsec` — a **validated** key.
  Every term is read through the store at each spawn (the stat that was
  already the cache's existence check), so a rewrite moves the key and a
  stale Module is unreachable *by key construction*, not by an invalidation
  protocol. No generation counters, no write hooks, no cross-instance
  coherence machinery — the persisted inode already carries everything a
  validator needs.
- **synthetic volume** (ProcFS) → no `moduleKey` hook → null. The KERNEL.md
  "never Module-cache /proc" pin holds by capability, not by a check.

Kernel side (`kernel.js`): `_imageCacheKey` calls the new hook; `_spawn` grew
one-entry-per-path bookkeeping (`_modulePathKey`: path → last key; when the
derivation moves, the old cache entry is deleted). Correctness never rests on
that bookkeeping — a changed file misses by key alone — it exists so `cc -o
a.out` loops REPLACE their entry instead of leaking one dead compiled Module
per rebuild. The ss-flavor exclusion, engine-rejected-bytes path, no-fs
dormant path, and the compile-options ABI (`MUST MATCH` host.js runModule)
are all byte-identical.

## The honest bound — ENROLLED as L66 (coordinator's ruling, 2026-07-31)

The validation floor is the store's timestamp resolution (ms on v4): a
same-inode, same-size rewrite whose final write lands in the same tick as the
cached generation's would derive the same key. Unreachable in-OS — write,
spawn, and rewrite are each their own process costing well over a tick — and
the part-3 test pins the sharpest real case (same-size generations, mtime
term alone). I initially recorded this only as a code comment; the
coordinator accepted the reachability analysis but overruled the filing
decision: the failure mode is SILENT stale code (nothing downstream ever
surfaces it), reachability arguments are claims about today's callers, and a
true-but-unenrolled gap comment reads as handled — the exact pattern the
register exists to kill. Now **L66** in `todos/LIABILITIES.md`, funded by
the recurring liability sweep #109 (the register requires a LIVE ticket and
the ruling was explicitly *no fix ticket* — the sweep is the re-examination
owner, which matches the accepted-not-scheduled intent). Complete closure, if
it ever bites: a content-hash key term (or a store write-generation counter)
— refused for now because it re-adds the per-spawn file read this cache
exists to skip.

## Tests

`tests/kernel/test_module_cache.js` — the ticket's three-assertion table:

| old assertion | fate |
|---|---|
| `rw binary ships bytes, no Module` | **INVERTED** → ships a Module, no bytes |
| `rw binary never touches the cache` | **INVERTED** → own entry, own miss |
| `rebuilt rw binary ships the NEW bytes` | **CONVERTED** → ships a NEW Module whose custom section proves the new bytes; entry count proves replacement |

plus new warm-hit legs (same Module object, hit counted, no new entry) and a
new **part 3**: the in-OS acceptance loop over driveBoot — `cc -o t t.c &&
./t`, run again warm, edit, recompile, rerun; asserts gen-two after and no
stale gen-one. The two generations print same-length strings on purpose so
the wasm images can be size-identical and the mtime term carries the guard.

`test_mounts.js`: the immutableKey policy test converted to moduleKey — RO
legs unchanged (alias sharing, stability), rw legs now assert a validated key
that MOVES on rewrite, and the `/usr/local` → `/var/local` escape asserts
the rw volume's key kind (it used to assert null). `test_procfs.js`: same
assertion, new hook name. The stats assertions downstream of the inverted
legs were re-derived (the ss pair's absolute counts shifted by the two new
rw events).

## Acceptance 2 measurement (desktop Safari, safaridriver)

`logs/2026-07-30/0443-measure-safari.mjs` (the 0385 harness re-run against
the fix; serve.js `--minimal`, in-page `__osOut`-setter timing, window
foregrounded): `gucman install cpython-clang` 852 ms, then `python --version`
**cold first spawn 152 ms, warm p50 132 ms** over 9 reps [128–136] — target
was ≤ 210 ms, pre-fix baseline 645 ms (4.9×). `python -c pass` warm p50
189 ms (was 1139 ms pre-fix ⇒ 6×). The residual ~130 ms is the 7-process
launcher chain — that is `todos/0444`'s half, not this one's.

Gotcha for the next Safari run: a wedged Safari (running but not answering
Apple Events) makes safaridriver fail with "session timed out … RWIApplication";
`pkill -9 -x Safari` + one clean relaunch fixed it.

## Why not a content hash

CLANG-CPP-EPIC's old resolution menu suggested a content-hash key for large
rw binaries. Hashing means reading the full image per spawn (the exact fs
work the cache exists to skip) or caching hashes with their own invalidation
problem. ino+size+mtime is read from one stat, already performed, and is the
same validity oracle every build system trusts.
