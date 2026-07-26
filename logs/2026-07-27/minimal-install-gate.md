# The minimal-image install gate — testing the artifact we actually ship

2026-07-27, branch `minimal-install-gate`.

## The blind spot

Every suite in the estate boots the **fat** artifact:

- `tests/lib/image-fixture.js:33` bakes `os/os-system.img` with
  `foldPackages(…, 'all')`.
- `serve.js` did the same for every browser file — and carried a comment
  saying so, plus "A future deploy build serves the minimal blob + the
  packages pool instead."

The **deploy** (`comguc/scripts/build.mjs`) does the opposite: step 1 is a
plain `tools/mkimage.js --out=…` with no package fold, step 2 builds the
mkpkg repo and publishes it at origin-relative `/packages`. Optional apps
install at runtime, over HTTP.

Measured on this box: **111 MB fat vs 23 MB minimal**. They do not contain
the same files.

So the whole browser realm could be green, on a completely honest artifact,
and never once exercise what users boot. v170's commit message says
`netsurf-demos` is "preinstalled" — on the deployed image it is not; it is
an installable package. And nobody had ever booted gucOS and clicked
Install: the Software Center's install path was verified by code-read only.

## What landed

**`serve.js --minimal`** serves the deploy shape. Two constraints shaped it:

1. It must NOT bake over `os/os-system.img`. Both `image-fixture.js` and
   `serve.js` treat the blob's os-release `PACKAGES=` line as an identity
   axis (a minimal blob at the same `VERSION_ID` is *not* that fixture), so
   a minimal bake at that path would make every other suite detect a
   package-set mismatch and re-bake — a green sweep turned slow and racy.
   It bakes a sidecar `os/os-system.minimal.img` and only *serves* it under
   the `os-system.img` URL, reusing the overlay-sidecar mechanism that was
   already there (`resolveOverlayPlan` → `servedImageName`).
2. `--minimal` and `--overlay`/`--clang` are refused together. An overlay is
   an additive augmentation of the dev image; the deploy's bake is plain.
   Letting one silently win would serve an artifact nobody asked for.

**`tests/browser/os-minimal.mjs`** (new; sweep baseline 39 → 40) boots that
blob plus a real served repo and installs `netsurf-demos` through the
Software Center UI, driven over the wm agent protocol (`wmctl wait label` /
`wmctl click` — real windows by live text, never pixel coordinates).

The design rule for the whole file: **nothing in it lists a demo, a package,
or a count.** The demo set comes from `vendor/netsurf/demos/demos.js`, the
planted file set from `drive.js pkgSeedPlants()`, the catalog and card
ordering from the live `index.json`, the base version from `os/image.json`.

Two things keep it honest:

- **The negative control is the point.** Before the install: no baked twin
  under `/usr/opt`, no seed destination, zero planted files, no install-DB
  record. Pointed at the fat image the file goes red — verified: 10 FAILs,
  including all four absence assertions and the `PACKAGES=` check. That is
  what stops this suite from quietly degenerating into a second copy of
  `os-gucman.mjs` if the image shape ever drifts back.
- **"The file is present" is not "the page works."** After the install the
  demo's own load-check pill is read off the composited pixels — painted red
  by the demo's external stylesheet, flipped green by its external script —
  with a script-stripped copy as the in-file red control. The predicates are
  `NSDEMOS.PILL`, shipped into the page as source, so this file holds no
  second copy of the colours.

## The one-character bug that wasn't pinned

`software.c:428` gates listing on `g_base < minBase`. `mkpkg` stamps every
package that declares no explicit `minBase` with the **current image
version** (`tools/mkpkg.js:455`), so `minBase == base` is the normal case for
a freshly shipped package. The run reports it plainly: **15 of 15** catalog
packages sit exactly on the boundary.

Had that operator been `<=`, the entire catalog would have listed
permanently greyed as "needs a newer OS" on the very version that introduced
it. Nothing pinned it.

`test_software_e2e.js` now asserts both sides against a synthetic two-entry
repo — `minBase == base` → `[available]` with Install enabled, `base + 1` →
`[needs newer OS]` with Install disabled — with the base derived from
`os/image.json` so it does not rot at v171. Verified red by flipping the
operator: `zz-base-equal 1 [needs newer OS]`, Install `en=0`, and
`driveBoot`'s loud-symptom gate throws on the unreachable wait.

## What this pins, and what it does not

The minimal bake is pinned **by property, not by derivation**: the test
asserts the served blob's baked package set is EMPTY (`bakedPackages()`),
that the booted `/usr/share/os-release` carries no `PACKAGES=` line, and
that its `VERSION_ID` matches the manifest.

It does **not** derive its flags from `comguc/scripts/build.mjs`. That is a
deliberate call: a cross-repo dependency inside the c-compiler suite costs
more than it buys (the deploy repo is not present in every checkout). The
consequence is real and worth naming: if the deploy later starts folding
some package back into its bake, this gate will not notice — it will keep
asserting an empty package set and keep passing. What it does guarantee is
that *a* no-fold blob plus a live `/packages` repo boots, installs and works.
