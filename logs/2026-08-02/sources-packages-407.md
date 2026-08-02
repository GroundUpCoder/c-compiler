# #407 — mechanical `<pkg>-sources` companion packages

jku: *"could we add a quick light task that bundles \*-sources packages for
most of the packages we have? … Specifically, I want gcode-sources, so it can
be seen."* The scope is the mechanical general rule; `gcode-sources` is the
acceptance demo.

## The rule (one rule, no per-package hand edits)

`os-common.js sourcePackageDefs()` synthesizes one `<name>-sources` package
per **source-bearing unit**, two derivations through one closure:

- **package units** — every ungated `packages/<p>.json` with at least one
  `project`/`c` files entry. Version = the parent's version. (A
  native-sibling def's source lives in the producer repo, which publishes
  only binaries — no unit, mechanically.)
- **image units** — every `os/image.json` system file built from source
  (`project`/`c` entries: `/usr/bin/gcode`, `/usr/bin/wm`, …). Name = the
  installed basename minus extension; version = the image version. A name a
  package unit already claims is the same software twice — package wins.

The payload is the unit's **compile closure** mirrored at repo-relative
paths: every project json reached through `deps`, every listed source, every
`hdrs` file, and every header (`.h/.hh/.hpp/.inc/.def`) under every declared
include dir. Chosen over "the project's directory" so a project rooted in a
shared dir (`os/wm.json`; gucman's `includes: ".."`) cannot drag the whole
tree in, and over "no deps" so an app split across projects (netsurf's
12-source bin.json over its 360-source core) stays complete. Packages with
no compilable entry (fonts, `netsurf-demos`, `win32` — itself a source
package) get no unit: there is no "source code for the binary" to carry.

Synthesis is **mkpkg-only by construction**: `listPackages`, the fold, and
the baked image never see the set. `tools/mkpkg.js` builds the units through
the ordinary `buildPackage` pipeline (they are plain defs whose files are all
`bin` entries), so index/pool/freshness/pruning all behave identically.
Freshness adds the synthesis inputs (`os/image.json` / the parent def) to the
per-package scan.

## The four design questions

1. **Manifest layout** — the SAME index/pool as binary packages. A -sources
   package is an ordinary package; nothing downstream (gucman, serve.js,
   deploys) changes.
2. **kfs landing** — payload at `/opt/<pkg>-sources/<repo-relative path>`;
   every def declares `srclib: {src: {<parent>: "."}}` — a new `'.'`
   (payload-root) form of the existing srclib source-namespace tier — so the
   tree reads at **`/usr/local/src/<parent>/<repo path>`** uniformly.
   *Why not `/usr/src/<pkg>`:* `/usr` is the sealed image volume — the first
   e2e run failed with `mkdir /usr/src: Read-only file system`. `/usr/src`
   is the FOLD's tier (baked srclib namespaces); `/usr/local/src` is the
   writable install twin (`/usr/local -> /var/local`). Installed sources at
   `/usr/local/src/<name>`, baked at `/usr/src/<name>` — exact srclib
   parity, one convention.
3. **Mechanical generation** — yes; see the rule above. Adding a package or
   a baked binary tomorrow yields its -sources automatically. The '.' form
   is enforced consistently: validator (os-common), gucman's C plant, the
   fold twin, and mkpkg's payload cross-check.
4. **Image size** — sources ship **exclusively through `/packages/`**
   (fetched on demand at install); the baked blob is untouched by
   construction. Measured: the only image delta is gucman's `'.'` support,
   **+142 B of wasm** (147,912 → 148,054). The package repo grows by **50
   units, 25.6 MiB gz total** (largest single payload `netsurf-sources` at
   3.5 MiB — far under the 25 MiB Cloudflare per-file cap). mkpkg now warns
   loudly on any payload over that cap (the #408 class). Full-set build:
   +~4 s on the ~85 s cold build, ~0.2 s warm (mtime reuse).

## Numbers (v219 tree)

50 units: 12 package-derived + 38 image-derived. 112 MiB raw closure text →
25.6 MiB gz. `gcode-sources` = 87 files / 280 KB gz (gcode.c + its bin.json
+ cJSON + the curl/lineedit/libbb dep closure). Known duplication: the ~15
win32-veneer apps each carry the win32+freetype closure (~0.5 MiB gz each) —
accepted; payloads are per-unit and independent.

## Tests

- `tests/host/test_source_packages.js` — the rule end to end host-side:
  both derivations present with right version lineage, mechanical
  exclusions, uniform defs, determinism, `'.'`-srclib validate/fold, and a
  real mkpkg build of `cc-sources` (control.json section + payload members).
- `tests/kernel/test_gucman_sources_e2e.js` — the acceptance demo on a
  booted minimal image: `gucman install gcode-sources` (image derivation)
  and `lua-sources` (package derivation, the required second package),
  `/usr/local/src/<name>` namespaces planted, **gcode.c byte-exact vs the
  repo (in-OS sha256sum)**, exact remove replay, no tier residue.

The interactive "open it in gcode itself" leg needs a live Anthropic
backend, so the automated proof is byte-exact readability in-OS; the gcode
CLI reads `/usr/local/src/gcode/os/gcode/gcode.c` like any file.
