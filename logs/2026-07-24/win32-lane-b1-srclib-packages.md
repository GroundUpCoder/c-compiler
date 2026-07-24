# win32 Lane B1 — srclib package vocabulary + win32 payload + freetype shims

Lane B1 of the win32 source-lib stream (design: the source-lib design pass,
§3 the source-lib manifest, §4 win32 as proof customer). Lane A (compiler FS
`__require_source` + system includes, 0358ec7) landed the COMPILER side; this
lane lands the PACKAGE side: get the srclib payload planted at the standard
install locations, both as an installable package (gucman) and as a baked
fold. No compiler.js change; no require blocks (that's B2).

## What landed

- **mkpkg `tree` manifest entry (§3.2, Node-only)** — recursive directory
  copy `{"tree": "<repo-relative dir>", "exclude": [glob, ...]}`: dotfiles
  always excluded, symlinks REFUSED (tar_validate's file/dir-only rule),
  exclude globs prune subtrees. ONE enumerator (`os-common listTreeFiles`)
  is shared by mkpkg's `assembleTree`, `foldPackages`, and BOTH freshness
  scans (`newestPkgInput`, `newestBakeInput`) — payload contents and
  staleness agree by construction. Tree entries expand to per-file `bin`
  entries; never reach seedEntries raw, so the browser worker (which can't
  enumerate dirs over XHR) never sees one.
- **`srclib` package section (§3.1)** — `{include: [payload dirs], src:
  {ns: payload dir}}`, shape-validated by `os-common validateSrclibShape`
  (ns = `[a-z0-9_-]+`; namespaced require names can never collide with
  builtins, which carry no '/'), mapped dirs checked against the ASSEMBLED
  payload by mkpkg (and the folded manifest by foldPackages); copied into
  control.json.
- **gucman srclib plant/remove** — install plants the two symlink farms:
  per TOP-LEVEL entry of each include dir →
  `/usr/local/include/<entry> → /opt/<name>/<dir>/<entry>` (a subdir like
  `freetype/` rides as one link), one link per src namespace →
  `/usr/local/src/<ns> → /opt/<name>/<dir>`. Neither tier exists on a
  virgin root — mkdir-if-absent, recorded in the DB (`srclib_dirs`) so
  remove rmdirs them once empty. DB arrays `include_entries[]` /
  `src_namespaces[]`; refuse-on-exists + full unwind, replayed in reverse
  on remove; `info` prints both lists.
- **foldPackages baked twin** — `/usr/include/<entry>` +
  `/usr/src/<ns>` links into `/usr/opt/<name>/...`; `/usr/include` +
  `/usr/src` join the system dir set only when a folded package carries
  srclib; collisions are the existing claim() throw.
- **freetype self-contained shims (§3.4)** — 12 committed
  `vendor/freetype/srclib/<name>.c` shims; the general rule is
  "an FS-require-able source is a SELF-CONTAINED TU": the three build
  defines live in-file, ifndef-guarded so `-D` duplicates stay legal; each
  shim `#include "../src/<dir>/<name>.c"`. lib.json sources flipped to the
  shims (compilerArgs kept — redundant under the guards). All freetype
  consumers (term, win32, mgp) build through lib.json, so the flip is
  uniform.
- **packages/win32.json** — the §3.3 def: include tree (os/win32/include +
  demo ft2build/myft* + freetype header tree), the 11 veneer TUs +
  menucore + headers + wwinmain.c under src/win32/, fontcore.h one level
  above, freetype srclib/ + upstream src/ side by side. NO bin/menu/
  openwith/desktop — a source-lib has no desktop presence (explicit in
  Lane C). ~326 payload members, 0.9 MiB compressed.
- **image v154 → v155** (the fat image gains the srclib fold; blob grows
  93,228,632 → 97,955,256 bytes).

## The byte-identity gate (WATCH-ITEM #1) — PASSED

Same-tree control (two `--packages=all` bakes of the unmodified tree):
38 differing bytes = the 32-byte seal hash (superblock offset 36) + 6 ASCII
digit bytes at the two quake `__TIME__` string sites (~offset 90.33 MB).
The flipped tree (shims + lib.json flip ONLY, still v154, no win32 pkg)
vs control: exactly the same 38-byte profile — seal + 6 digits inside the
same two quake windows. ZERO other bytes moved: the flip is codegen-inert.

## FINDING for Lane B2 — `..` is LEXICAL in kfs, refuting design §1.5

The design doc claims (§1.5, §4.3) that a `..` inside a resolved path
(gdi32.c's `"../fontcore.h"` compiled as `/usr/src/win32/gdi32.c`) walks
POSIX-style THROUGH the namespace symlink into the payload. **That is not
what BlockFS does**: host.js `_walkPath` documents "`'..' is collapsed
lexically by _resolvePath before the walk (logical, not physical — like
realpath sans -P)`", and probes confirm it on every tier (kernel-side
MountFS, process-side RemoteFS, raw volume):
`/usr/src/win32/../fontcore.h` collapses to `/usr/src/fontcore.h` (ENOENT)
before the symlink is ever entered. Consequence for B2: a required TU's
`..`-relative include resolved against its VISIBLE tier path misses — this
affects both gdi32.c's `"../fontcore.h"` and every freetype shim's
`"../src/..."`. B1's plant and payload layout are correct and unaffected
(inside the payload's real dirs, lexical == physical — asserted by the new
e2e legs). B2 options, for the coordinator: (a) resolve require names to
their PHYSICAL payload path (readlink through the namespace symlink) before
using them as TU filenames — one readlink at the tier, driver/resolver-side;
(b) a physical-`..` reading path in createCcDriver's file reader;
(c) change kfs to physical walks (estate-wide semantics change — not
recommended lightly). The §7 rejection of "realpath-canonicalizing the
resolver" was premised on the physical-walk claim and should be revisited.

## Notes / gotchas

- Package `text` entries are os/-relative (readAsset), `bin`/`tree`/`project`
  repo-relative — the win32 def uses `text` for os/ sources and `bin` for the
  vendor freetype demo headers (the design doc's §3.3 sketch says "text" for
  those; the actual vocab distinction is by base dir).
- mkpkg's assembleTree grew a claim() guard: tree expansion introduces the
  two-entries-one-path class (a tree file shadowed by an explicit entry),
  which plain Object assignment would resolve silently.
- The quake `__TIME__` noise makes ANY two fat bakes differ at ~6 digit
  bytes + the seal — a same-tree control bake is mandatory before reading a
  byte-diff (the Lane A/0284 precedent).
