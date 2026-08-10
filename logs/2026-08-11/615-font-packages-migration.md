# #615 — the two font packages migrate to gucos-packages (tests included)

The first live-content migration into the sibling data repo — the proof that
the #611→#612→#613→#614 independence chain delivers on real content. Moved:
`packages/font-unifont.json` + `packages/font-noto-cjk-mono.json`, their four
`vendor/fonts/` blobs, and `tests/kernel/test_fontpkg_e2e.js`. **Byte delta on
the c-compiler checkout: −47,899,990 B (~47.9 MB)** across 7 files. History is
NOT rewritten (coordinator ruling, design §10 Q3) — the ~46 MB of pack stays;
this is a working-tree delete, and the win compounds per future clone-free
edit to the fonts, not retroactively.

## Where things landed (gucos-packages lane-615)

- `packages/<name>.json` — same vocabulary, `bin:` paths now
  `assets/<name>/…`, resolved against the sibling root by mkpkg's `--defs`
  seam (`assembleTree` binds readers per owning source; verified by a real
  `mkpkg --defs=<sibling> font-unifont font-noto-cjk-mono` build).
- `assets/<name>/` — payload blobs + licenses, byte-identical (sha256
  re-verified against the values `vendor/fonts/README.md` pinned at fetch
  time; provenance table moved to the sibling's `assets/README.md`).
- `tests/test_fontpkg_e2e.js` — rewired to the sibling runner contract
  (CC_ROOT env for the c-compiler libs, `__dirname/..` for its own repo,
  `ensurePackages(…, { defs: [REPO] })`), registered in `tests/manifest.json`
  with its native `timeoutMs: 900000`. All 28 checks pass hand-run, including
  the pixel tofu/real-glyph proofs and the bit-exact ksvc title leg — the
  #464 text coverage runs from the sibling, unreduced.
- `tests/test_repo_contract.js` grew the #518 minBase-honesty lint for
  pure-data defs: the fonts must not fall out of the lint's reach by moving
  out of the dir `test_mkpkg_minbase.js` scans.

## The four kickoff hazards, as decided

1. **Native referents of font-unifont.** The deep rule (tests/lib/
   sibling-tests.js `absent` outcome): a NATIVE c-compiler test must never
   depend on the sibling checkout — so none of the three referents was
   pointed at the sibling. Instead:
   - `ensurePackages` grew an **explicit** `opts.defs` (never
     auto-discovered — auto-discovery here would be the back-door coupling
     the sibling repo exists to remove). Only sibling-resident tests pass it.
   - `test_defaults_sync_e2e.js`: the non-app data-package default is now a
     hermetic `font-fixture` package built through a private `--defs` root
     with an inline-`content` face — the `test_gucman_upgrade_e2e` precedent
     (fa.ttf = "face-a\n") already proves the fontchain skips an unloadable
     face across real boots, and nothing in this test renders the face; the
     `/etc/fonts/fallback` PLANT + sync idempotency is the subject and keeps
     full coverage. All 39 checks pass.
   - `test_mkpkg_rust.js` purity arm: → `netsurf-demos` (the cheapest
     remaining no-compile base package).
2. **The `!byName.has('font-unifont-sources')` vacuous green**
   (`test_source_packages.js:84`): replaced with a hermetic fixture def
   through the `packagesDir` seam — a bin-only data def asserted to get NO
   `-sources` unit. Pointing the pin at whichever real def happens to
   qualify is exactly how it went vacuous this time. Bonus find: the
   kickoff's hazard list missed a FIFTH referent, `test_mkpkg_minbase.js`,
   whose anti-vacuity guard ("the lint saw at least one pure-data package")
   would have gone RED if the fonts were the last pure-data defs — they are
   not (`netsurf-demos` is tree-only, hence pure-data by that classifier),
   so it stays green with no change (verified by running it).
3. **`mkimage --packages=all` drops the fonts.** Decided: that is CORRECT,
   and it must be possible, not silent. The shipped image is the MINIMAL
   bake (comguc build.mjs — packages install at runtime from the merged
   /packages index, which comguc already builds with the sibling, mandatory,
   since #614), so there is zero user-facing regression at ship; neither
   font is in `defaultPackages`. The fat image is a dev/test fixture whose
   identity axis (`bakedPackages`) catches the shrink: the fixture gate
   reported `package set [...font-noto-cjk-mono,font-unifont...] != wanted
   [...]` and re-baked once (201.8s), exactly the designed behavior — not
   silent. `tools/mkimage.js` grew `--defs=ROOT` (repeatable, loud
   preflight, mkpkg's exact seam shape) so a fat image WITH sibling packages
   is one explicit flag away — foldPackages/newestBakeInput already
   threaded defs (#612/#614); only the CLI exposure was missing. No estate
   baker passes it, deliberately: a fat image's content must not depend on
   which optional checkouts sit beside the tree.
   **No image.json version bump**: the shipped minimal blob is
   byte-identical (fonts were never in it, no baked source changed), the
   fat blob's freshness rides the package-set comparison (proven above),
   and the browser OPFS key only needs to move when shipped-blob content
   moves.
4. **Text coverage does not regress**: `gucos-packages/tests/
   test_fontpkg_e2e.js` runs as a kernel-suite member whenever the sibling
   checkout is present (this box: `via main-clone sibling`, and the suite
   artifact's `sibling` block records members:2 / status:"ok"; absent →
   loud skip, closed at the ship boundary by comguc's mandatory sibling),
   and its own PASS above is the direct evidence the glyph pipeline is
   exercised — pixel-level tofu→real-glyph→tofu round trip plus the ksvc
   bit-exact title strip.

## Counts (predicted before the gate)

- native kernel members: 172 → **171** (fontpkg row + file removed together;
  registry set-equality holds)
- sibling members: 1 → **2** (manifest + file added together)
- total: **173, unchanged**
- scheduling: the native fontpkg row was UNTAGGED (= assumed boot-heavy) and
  is PKG-classified by the textual `ensureMinimalImage` scan, which reads
  sibling sources via `e.src` — so the sibling member lands in the same XL
  class it had natively; no scheduling change at all (the kickoff's
  "safe over-charge" caveat turns out to be a no-op here).

## Gotchas for the next migration wave

- `tests/kernel/timings.json` keeps a stale `test_fontpkg_e2e.js` key —
  scheduling hint only, dropped at the next `update-timings.js` regen;
  hand-editing the committed snapshot would be worse.
- The defaults-sync fixture def needs `minBase` ≥ 1 explicitly (#518 — an
  undeclared minBase inherits the current image version, which would be
  fine at install time but is the exact silent-default the lint exists to
  catch).
- The sibling test spawns with cwd `<cc>/tests/kernel`; requires resolve
  via CC_ROOT, its own repo via `__dirname/..` — copy the
  `test_repo_contract.js` header shape, including the loud CC_ROOT check.
