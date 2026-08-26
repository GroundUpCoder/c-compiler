# #739 — `node os/boot.js` re-baked the whole system image on every run

*2026-08-26, lane/739*

## What was wrong

`os/boot.js` takes a sidecar lock beside the writable root image for the whole
life of a boot (todos/0293, one boot per image pair). With the DEFAULT in-repo
image that lock is `os/os-root.img.lock` — inside the directory
`COMMON.newestBakeInput` walks, and its mtime is always *now*. So the 0082
input-freshness gate found a "bake input" newer than the blob on every run, and
a default headless boot could never take the reuse path at all.

Measured here, two consecutive default `node os/boot.js` runs on an unedited
tree, pre-fix:

```
[boot] system blob is input-stale (os/os-root.img.lock is newer) — re-materializing
[boot] baking system image (manifest v280)
                                                                   236 s
```

Post-fix, same tree, same blob:

```
[boot] image .../os/os-system.img (reused) + .../os/os-root.img
                                                                   0.12 s
```

## Why nothing caught it

Every test in the estate boots with `--image=<mkdtemp>`, which puts the lock in
tmpdir, outside the `os/` walk. The defect was reachable only by a human or an
agent running `node os/boot.js` in the repo — the dogfood / in-OS dev-loop path,
which is precisely the gamedev iteration cycle this ticket funds.

## The shape of the fix

The class was already understood: `newestBakeInput` excluded `*.img` and
`*.img.tmp-<pid>` with the comment *"an output counted as an input would
perpetually self-stale the bake"*. The lockfile is a runtime artifact in exactly
that position and was simply missed.

The deeper reason it was missable is that the exclusions were regexes written
against **the names of the day**, while the names themselves were string
literals in `os/boot.js` and `tools/mkimage.js`. Nothing tied the two together,
so the excluder and the creators could drift — and did.

So `os/os-common.js` now owns the names:

| builder | produces | who calls it |
|---|---|---|
| `imageBakeTmpPath(img, pid)` | `<img>.tmp-<pid>` | `tools/mkimage.js` |
| `imageInstallTmpPath(img)` | `<img>.installing` | `os/boot.js` |
| `imageLockPath(rootImg)` | `<rootImg>.lock` | `os/boot.js` |

and `isImageArtifactName(name)` is the ONE predicate both freshness walks call.
A behavioural test leg reads the lock path back out of boot.js's own exit-5
refusal message and asserts the predicate excludes it, so the seam is pinned by
what boot.js *does*, not by a literal restated in a third place.

The predicate keys off the image-artifact shape (`*.img.<suffix>`), deliberately
**not** a bare `*.lock` glob: a genuine lockfile source input must stay an input,
and a leg pins that too.

## Two more of the same class, fixed in the same commit

Both were found by looking rather than by a later measurement:

1. **`*.img.installing`** — boot.js's fixture-install temp — was never excluded
   either. A killed install leaves one behind, and it then reads as an
   ever-newer input forever, exactly like `*.img.tmp-<pid>`. It was also missing
   from `.gitignore`, which had the lock but not this.
2. **`newestPkgInput`** (mkpkg's twin) carried a *duplicate copy* of the same
   two regexes, and its own comment records that it walks `os/`. So a live
   headless boot restaled every package build for as long as it ran. It now
   calls the shared predicate.

## Classification

`quality-gap`, as filed — the gate erred in the SAFE direction (it re-baked when
it need not; it never served a stale blob). What was broken is the reuse path's
usefulness, measured at 236 s → 0.12 s.

## Verification the fix did not turn the gate off

The point of excluding OUTPUTS is that INPUTS keep working. Confirmed live: with
the fix in place, restoring `os/os-common.js` (a genuine edit) printed
`system blob is input-stale (os/os-common.js is newer) — re-materializing` and
re-baked — naming the real culprit instead of the lockfile. A synthetic leg pins
the same property for `compiler.js`.
