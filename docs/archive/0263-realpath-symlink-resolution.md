# 0263 — libc realpath()/readlink -f don't resolve symlinks (RemoteFS flavor is lexical-only)

- **Status**: done
- **Design**: physical resolver kernel-side; FS_REALPATH RPC now walks lstat/readlink

## Goal

POSIX `realpath(3)` must return a canonical path with **symlinks resolved**.
The RemoteFS-flavor implementation (host.js `realpath` import, ~line 4531)
returns `this._resolvePath(path)` — the LEXICAL normalizer ("realpath sans
-P", host.js ~2701) — so the final path keeps every symlink component.
Busybox `realpath` and `readlink -f` (both backed by libc realpath) inherit
the bug. The standalone-Node flavor (host.js ~479, `fs.realpathSync`) is
correct — the two flavors disagree.

Repro (any OS boot):

    ~ # readlink /usr/bin/quake        # /usr/opt/quake/quake  (correct)
    ~ # realpath /usr/bin/quake        # /usr/bin/quake        (WRONG)
    ~ # readlink -f /usr/bin/quake     # /usr/bin/quake        (WRONG)

Found during 0262: package launcher scripts wanted
`cd "$(dirname "$(realpath "$0")")"` to self-locate through the
/usr/local/bin → /opt symlink chain and had to fall back to a manual
readlink-chase loop (see packages/quake.json — simplify those launchers
back to realpath once this is fixed).

## Plan

- Implement symlink resolution in the RemoteFS realpath: walk components,
  `readlink` each, bounded hops (ELOOP), against the brokered fs — or add a
  kernel-side FS_REALPATH if per-component RPCs are too chatty.
- Conformance-style regression: a kernel e2e (or test_pipes-style unit)
  asserting `realpath` through a link chain, plus `readlink -f`.

## Acceptance

`realpath /usr/bin/quake` prints the fully-resolved target in a booted OS;
the package launchers can drop their readlink-chase loops.

## Resolution

Physical resolution landed KERNEL-SIDE — the `FS_REALPATH` RPC already
existed but resolved lexically (`fs._resolvePath`); it now calls a new
`fs.realpathPhysical` that walks the path one component at a time against
`lstat`/`readlink`, following symlinks (absolute targets restart at root,
relative ones splice against the link's already-resolved parent), collapsing
`.`/`..` PHYSICALLY, bounded by `SYMLOOP_MAX` (→ `ELOOP`), every component
required to exist (→ `ENOENT`, `fs.realpathSync`/glibc parity). One shared
`physicalRealpath(fs, input)` in host.js backs both `BlockFS` (in-process) and
`MountFS` (the kernel-side fs, so each `lstat`/`readlink` hop routes by mount
prefix — `/bin`→`/usr/bin`, `/usr/local`→`/var/local` resolve). The
chattiness worry is moot: the walk stays kernel-local, so a brokered realpath
is exactly ONE RPC. Process-side `RemoteFS.realpathPhysical` is that one RPC,
surfacing the errno (unlike the best-effort lexical `_resolvePath`); the
`toWasmEnv` realpath import calls `this.realpathPhysical` and returns
`NULL`+errno on failure, matching the standalone-Node flavor (`fs.realpathSync`,
host.js ~479) exactly — the two flavors now AGREE. Added `ELOOP`:40 to host.js
`errnoMap` (the C libc has no `ELOOP` macro and compiler.js is untouched, but
errno 40 is still set; `strerror` cosmetics only). Busybox `realpath` and
`readlink -f` share `xmalloc_realpath_coreutils`, which itself handles the
missing-final-component case (resolve the existing prefix, re-append the tail)
off our `ENOENT` — so both commands are correct end to end.

Launchers simplified back to `cd "$(dirname "$(realpath "$0")")"`:
`packages/quake.json` and `packages/sent.json` (both had the readlink-chase
loop; both verified — installed-mode quake still opens its window,
`test_gucman_quake_e2e`).

Test: `tests/kernel/test_realpath_e2e.js` (real busybox over the baked
`/bin`→`/usr/bin` + `ls`→`coreutils` + `/usr/local`→`/var/local` chains,
relative `../` targets, ELOOP failure, missing-final parity) — 9/12 legs are
RED on the pre-fix tree, all green after. `test_os_boot`'s `realpath
/bin/../tmp` golden was updated `/tmp`→`/usr/tmp` (it encoded the lexical bug:
physically `/bin`→`/usr/bin` so `..`→`/usr`).

NOT done (deliberately, blast-radius): `_watchCanon` (kernel.js, the
FS_WATCH attribution seam that fswatch.h:31 flags for this upgrade) still uses
the lexical `_resolvePath`. A physical resolver there requires the watched
path to EXIST, which conflicts with watching not-yet-created paths and the
rename-over-save mutation choke where existence is racy — the safe form
(resolve the PARENT physically, keep the final lexical) is a separate change
with its own fswatch test surface. Left as-is; the alias-attribution residual
is unchanged and harmless to path-consistent consumers, as documented there.

NOT done (out of scope for this branch, per the coordinator): the
merge-to-main + `image.json` version bump + re-bake + deploy. This branch
touches only host.js/kernel.js/tests/packages — no image bake (the launcher
script change only lands in a `--packages=all` blob at the next bake).
