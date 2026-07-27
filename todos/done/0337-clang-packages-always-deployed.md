# 0337 — the *-clang packages must always be in the deployed gucman index

- **Status**: done
- **Design**: `~/git/meta/gucos/notes/clang-to-public-design.md` (the original
  CLANG-CPP-EPIC Part II §7 channel this item makes permanent)

## Goal

Standing instruction: **no clang package is ever baked into the base image, and
EVERY clang app we build is always installable through gucman on the deployed
origin.** Two things stood between that and the tree:

1. **The superset index was opt-in.** The external deploy repo's build took
   `--clang` to emit the SUPERSET package index; a plain build emitted base.
   And the reversion is ACTIVE, not passive — a plain build orphan-prunes the
   `-clang` pool blobs and rewrites `index.json` back to base. So it was not
   that people *forgot* the flag; every ordinary deploy REMOVED the clang apps
   (the deploy ledger: `clang:true` on 3 deploys, `clang:false` on the 41
   after). A default that reverts on the next forgetful deploy cannot deliver
   "always", so the flag was the defect, not the ergonomics.

2. **Three published apps had no package definition at all.** The sibling
   overlay publishes ten `/usr/bin/*` payloads; `packages/` defined seven.
   `gameboy-clang`, `stl4` and `sdldemo` would not have shipped even with the
   flag on — they were built and then silently reached nobody.

## Plan

- Invert the external build's default: clang superset ON, opting out explicit
  (`--no-clang` / `--base-only`, `pnpm build:base`); `build:clang` keeps
  working as an alias. A missing sibling under the DEFAULT is a loud failure
  with the opt-out spelled out — a mis-provisioned box must never silently
  ship base.
- Write the three missing definitions: `packages/gameboy-clang.json`,
  `packages/stl4.json`, `packages/sdldemo.json`.
- **The general fix — a drift gate** (`clangDriftCheck` in `tools/mkpkg.js`):
  under `--clang`, every `/usr/bin/*` payload the sibling overlay publishes
  must be claimed by some `packages/*.json` `clangApp` entry, or the build
  fails before anything is built. The gate is on the OVERLAY side of the
  relation, not a list of names, so a new sibling project fails the build the
  first time it is published rather than the first time somebody notices it
  missing. A payload that deliberately is not a package needs an EXPLICIT
  entry with a reason in `tools/clang-unpackaged.json`; a stale exemption
  (payload gone, or since packaged) fails too.
- Harden the deploy's ROM guard to see INSIDE the package payloads: the pool
  blobs are content-hashed gzipped tars, so a ROM riding one is invisible to a
  filename scan of `dist/`. The overlay really does publish
  `/usr/share/gameboy/PokemonBlue.gb` (for the sibling's own local bake), so
  with the superset now the deploy default one careless `clangFile` entry
  would put a Nintendo ROM on the public origin.

## Naming

`stl4` and `sdldemo` are bare names with no `-clang` suffix, and that is
CORRECT, not drift: the sibling's `enforceClangConvention` binds only projects
built from a `$CC_ROOT/vendor/` tree (a build whose stock twin gucOS also
compiles with `compiler.js`, which must not be shadowed). Both are in-repo
demos of the sibling itself with no stock twin, so the convention exempts them
by its own rule. No rename is owed.

## Scope note — assets

The gate covers EXECUTABLES (`/usr/bin/*`): an unpackaged one never ships at
all, which is the failure this item exists to kill. Non-binary overlay payloads
belong to whichever package carries their binary, and a package is deliberately
free to leave one behind — `packages/gameboy-clang.json` drops the copyrighted
`PokemonBlue.gb` (the emulator runs its built-in test ROM bare), and the deploy
never hosts ROMs publicly.

## Acceptance

- `mkpkg --clang` against the real sibling: 10 overlay apps, all packaged;
  index carries all 10 `-clang`-channel names.
- A full deploy build with NO flag emits a 25-package index (15 base + 10
  clang), `build-info.json` `clang: true`; the 15 base entries are
  byte-identical to the pre-change index and `os/image.json`'s version is
  untouched (nothing `requires` is ever baked — `foldPackages` excludes it by
  construction).
- `tests/serve/test_mkpkg_clang.js` covers the gate: an unclaimed overlay app
  is exit 1, an explicit exemption builds clean, a stale exemption is exit 1.
- The deploy verifier's clang-app install leg SELF-ENABLES (it gates on
  `box2d-clang` being in the index) and passes — the old "1 expected skip" is
  gone.
