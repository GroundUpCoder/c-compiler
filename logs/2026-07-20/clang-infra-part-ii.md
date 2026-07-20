# clang build infra — CLANG-CPP-EPIC Part II (§7 the optional `*-clang` channel)

Branch `clang-infra`. Landed the OPTIONAL clang build/package infrastructure
from the epic's Part II. **No base `image.json` bump, no kernel change, no
gucman/software change** — the base OS image is byte-unaffected; everything here
is a package-channel + dev-server concern, dark until a `../clang-simplified`
sibling is present AND clang is explicitly requested.

## What shipped

1. **`serve-with-clang.js`** — a hard-fail WRAPPER around `serve.js` (not a
   fork). It preflights the sibling (present? `simple1/out/clang` built?
   `out-image/overlay.json` present + parseable?), then runs `mkpkg --clang`
   foreground, then DELEGATES the whole serve to the unmodified `serve.js`
   (`spawn … --clang --packages-index=clang`, stdio inherited). Every preflight
   miss is a loud `exit(1)` naming the fix command — it NEVER falls back to the
   base image. `serve.js`'s freshness/mkimage/overlay plumbing stays in one
   place; the wrapper owns only the failure policy. `--clang-root=PATH`
   overrides the sibling location; `--build-overlay` opts into running the
   sibling's producer foreground when the artifact is absent (absence is never
   *silently* healed).

2. **`tools/mkpkg.js --clang`** + the schema additions:
   - **`requires: "clang-sibling"`** (gate field) — filtered at the
     `listPackages` choke point in `os/os-common.js`. Default enumeration
     EXCLUDES any def carrying `requires`; only `mkpkg --clang` /
     `listPackages(…, {withClang:true})` includes them. This is what makes
     "base ships ZERO clang" true *by construction*: `mkpkg` no-flag,
     `foldPackages('all')` (→ serve.js's fat image, `boot.js --packages=all`,
     `image-fixture.js`) all take the default path and never see a `-clang` def.
   - **`clangApp: "<app>"`** entry type (mkpkg-only, refused by `seedEntries`
     like `link`): pulls `/usr/bin/<app>` out of the sibling's `overlay@1`
     artifact and plants it in the package tree. Bytes are verified through
     `os-common.loadOverlays` — the EXACT sha256/size enforcement the bake
     overlay uses, so there is one verifier and no drift. `newestPkgInput` folds
     the overlay's mtime for clangApp defs. Missing sibling/overlay under
     `--clang` is a loud `exit(1)`.

3. **`serve.js --packages-index=clang`** (one new flag) — asserts the served
   `/packages` repo is the clang SUPERSET (`dist/packages/index.json` lists ≥1
   `-clang` package) before listening; a base index here means the wrapper's
   preflight was bypassed → loud `exit(1)`. It never mutates anything (serve.js
   serves `dist/packages` verbatim, as today). Flagless serve.js is
   byte-identical to before.

4. **`packages/doom-clang.json`** — the shipped example `-clang` def (proves the
   schema + makes base-purity concrete against the real tree). Safe in the base
   pipeline: the `requires` filter excludes it from every default path.

## Naming rule held (epic §4.1)

Every clang-built binary visible in any gucOS `bin/` carries `-clang`. The only
unsuffixed names (`clang`, `wasm-ld`) are argv0 driver-adjacency symlinks INSIDE
a package prefix — never on `PATH`, and not yet emitted here (they ride the same
`clangApp` type once mk-overlay.mjs publishes the toolchain package).

## Guardrail tests (all green, registered in `tests/host/run.js`)

- `tests/serve/test_clang_base_purity.js` — (a) real repo: no `-clang` in the
  base set / `foldPackages('all')`, but `withClang` surfaces doom-clang; plus a
  synthetic tree proving a gated def is dropped and a malformed def stays visible
  (never silently smuggled past the filter).
- `tests/serve/test_serve_with_clang.js` — (b) the three preflight stages
  (sibling absent / toolchain unbuilt / overlay absent) each `exit(1)` with the
  fix command and never fall back to serving.
- `tests/serve/test_mkpkg_clang.js` — (c) `mkpkg --clang` clangApp sha256
  round-trip: a fake sibling → verified bytes land in the pool tarball + the
  index gains the `-clang` name; a TAMPERED sha256 → loud `exit(1)`, nothing
  copied.

`tests/run.js` RULES updated so a diff touching `serve-with-clang.js`,
`tools/mkpkg.js`, `os/os-common.js`, or `packages/` routes to the `host` suite
(no UNMAPPED).

## Base-image byte-invariance (confirmed)

`foldPackages(fs, path, ROOT, image.json, 'all').names` is unchanged by this
branch (doom-clang excluded). No `image.json` version bump. The bake inputs
(`compiler.js`, `host.js`, `os/` tree minus os-common's Node-only listPackages)
are untouched in a way that changes baked bytes — `listPackages` only affects
WHICH package defs are enumerated, and the enumeration for the fat fixture is
identical (the new gated def is filtered out).

## Follow-ons (epic §8, not filed here)

Real `-clang` package defs (doom/gameboy/sameboy/…) land as the sibling
publishes their overlay payloads; the toolchain packages
(`clang-toolchain-clang`, `clang-src-clang`) ride the same `clangApp` type. The
kernel content-hash module cache for large rw binaries (§2.4 option b) is its
own item.
