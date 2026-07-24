# win32 Lane 0 — PS_BUILTIN storefront state for baked packages

Lane 0 of the win32 source-lib build stream (design: the external
embedder's `win32-sourcelib-design.md`, §0.3 "Pre-existing gap" + §8):
a package folded into the fat image's sealed `/usr` (os-common.js
`foldPackages`) has no gucman DB record, so the software center showed
it as *Available* with a live Install button. Wrong twice over: the
package is already present, and a sealed `/usr/opt` payload is neither
installable nor removable. The wart predates win32 folding but becomes
glaring the moment it lands, so it's fixed first, generally — any baked
package, no hardcoded names.

## Mechanism

`PACKAGES=` in `/usr/share/os-release` is already the fat-image identity
axis (os-common.js writes it at bake; `bakedPackages` reads it host-side).
Both in-OS consumers now parse it the same way (a small comma-list reader
mirroring the `gm_base_version` os-release precedent — loaded once,
/usr is sealed so the line can't change under a running process):

- **software.c** grew `PS_BUILTIN`: in `PACKAGES=` + no
  `/var/lib/gucman/<name>.json` → card state "Built-in" (installed-green),
  Install button present-but-DISABLED, agent text `[built-in]`.
  Precedence rules: a DB record on top wins (install-over-the-top keeps
  plain INSTALLED semantics, remove replays the DB and lands back at
  built-in); built-in wins over the minBase gate (the package is already
  part of this OS, "needs newer OS" would be nonsense). Baked packages
  the catalog doesn't carry stay listed (the orphan-row honesty rule,
  built-in flavored), so a repo dropping a package can't make a present
  one vanish from the storefront.
- **gucman**: `list --all` prints `built-in` in the INSTALLED column
  (and `built-in (not in repository)` rows for baked names the index no
  longer carries); `info <name>` prints `installed: built-in` and no
  longer errors on a baked package that's absent from the repo and DB.
  Plain `list` stays DB-only by contract (installed == DB record).

The minimal image writes no `PACKAGES=` line, so everything keys off it
naturally: minimal boots are byte-identical in behavior (all cards stay
Available) — asserted by the untouched minimal session of the e2e.

## Tests

- `test_software_e2e.js` grew a FAT-fixture session: `[built-in]` card,
  disabled Install button (tree-adjacency probe: the BUTTON after the
  punes PkgCard has `en=0 text='Install'`), no `[available]` card
  anywhere on the fat image, CLI `list --all`/`info` agreement, and the
  install-over-the-top round-trip `[built-in]` → `[installed]` →
  `[built-in]` via FS_WATCH.
- `os-gucman.mjs` (browser, fat image): the two punes assertions flipped
  from `no` to `built-in` — they now pin the new truth in the Chromium
  realm.

Image bump v153 → v154 (gucman + software are seeded binaries).
