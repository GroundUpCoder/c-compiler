# 0263 — libc realpath()/readlink -f don't resolve symlinks (RemoteFS flavor is lexical-only)

- **Status**: open
- **Design**: —

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
