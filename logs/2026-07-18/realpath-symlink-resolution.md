# realpath(3) / readlink -f resolve symlinks physically (todos/0263, gucOS #76)

**P0.** A booted gucOS returned `realpath /usr/bin/quake` → `/usr/bin/quake`
(unchanged) instead of the fully-resolved `/usr/opt/quake/quake`. Busybox
`realpath` and `readlink -f` are both backed by libc `realpath()`, so both were
wrong. Root cause: the RemoteFS-flavor `realpath` import returned the LEXICAL
normalizer (`_resolvePath` — collapse `.`/`..`/`//` but keep every symlink
component), while the standalone-Node flavor (`fs.realpathSync`, host.js ~479)
was correct — the two flavors disagreed.

## Where the fix lives — kernel-side, not per-component RPCs

The `FS_REALPATH` RPC already existed (RemoteFS's `_resolvePath` calls it); it
just resolved lexically kernel-side. So the fix is one seam: the RPC handler now
calls a new `fs.realpathPhysical` instead of `fs._resolvePath`. Because the real
kernel-side fs (a `MountFS`) does the walk locally, a brokered realpath is
exactly ONE RPC — the "per-component readlink storm" the ticket worried about
never materializes.

`physicalRealpath(fs, input)` (host.js, shared by `BlockFS` and `MountFS`):
walk one component at a time against `lstat`/`readlink`; a symlink expands in
place (absolute target → restart at root, relative → splice against the link's
already-resolved parent); `.`/`..` collapse PHYSICALLY (a `..` after a symlink
is the target's parent — the crux); `SYMLOOP_MAX` hops → `ELOOP`; every
component including the last must exist → `ENOENT` (glibc / `fs.realpathSync`
parity). On `MountFS` each hop routes by mount prefix, so `/bin`→`/usr/bin` and
`/usr/local`→`/var/local` resolve across volumes.

Process side: `RemoteFS.realpathPhysical` is the one RPC, and unlike the
best-effort lexical `_resolvePath` it SURFACES the errno. The `toWasmEnv`
realpath import calls `this.realpathPhysical` and returns `NULL`+errno on
failure — so in-process `BlockFS` and brokered `RemoteFS` and standalone-Node
all now agree.

## Gotchas hit

- **`ELOOP` wasn't in host.js's `errnoMap`** (nor a C libc macro, but
  compiler.js is untouched). `setErrnoName('ELOOP')` would have thrown — this
  path is the first to ever set it. Added `'ELOOP': 40`.
- **Busybox `realpath` ALSO handles missing finals.** Both `realpath` and
  `readlink -f` share `xmalloc_realpath_coreutils`, which on our `ENOENT`
  resolves the existing PARENT and re-appends the tail — so both commands
  succeed on `dir-exists/file-missing`. Our libc `realpath()` returning `ENOENT`
  is exactly what triggers that. (`__GLIBC__` is undefined here, so busybox
  passes a real buffer, not `realpath(path, NULL)` — our NULL-buf `EINVAL`
  guard never fires.)
- **A golden encoded the bug.** `test_os_boot`'s `realpath /bin/../tmp`
  expected `/tmp` (lexical). Physically `/bin`→`/usr/bin`, so `..`→`/usr` →
  `/usr/tmp`. Updated the golden and its comment.
- **`queue.js done` staged a stale ticket blob** (the known git-mv gotcha) —
  re-`git add`ed the moved file.

## Launchers simplified

`packages/quake.json` and `packages/sent.json` both carried a manual
readlink-chase loop ("libc realpath is logical-only"); both are back to
`cd "$(dirname "$(realpath "$0")")"`. Installed-mode quake still opens its
window (`test_gucman_quake_e2e`), and `$0` resolves correctly through both the
installed (`/usr/local/bin/quake`→`/opt/quake`) and baked
(`/usr/bin/quake`→`/usr/opt/quake`) layouts.

## Left undone on purpose

`_watchCanon` (the FS_WATCH attribution seam fswatch.h:31 flags for this
upgrade) stays lexical — a physical resolver there needs the path to EXIST,
which conflicts with watching not-yet-created paths and the racy rename-over
mutation choke. The safe form (resolve parent physically, keep final lexical)
is a separate change with its own test surface. And merge/bump/bake/deploy is
the coordinator's serialized follow-up (collides with the storefront deploy
lane, not these files).

## Gate

Kernel sweep 92/92 green (the gucman_quake window-wait flaked once under 294%
CPU contention, green on re-run and in isolation). blockfs 15/15, host PASS.
compiler.js untouched. New `test_realpath_e2e.js`: 9/12 legs RED pre-fix, all
green after.
