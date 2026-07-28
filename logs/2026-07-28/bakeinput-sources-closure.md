# 0354 — the bake-input closure follows `sources`, not just `deps`

`newestBakeInput` (os/os-common.js) is the estate's answer to "is this blob
stale?". Its own header states the contract: *the newest mtime across
everything that can change the system blob's bytes*. It expanded a project
through `deps` and walked the project's own directory — and stopped there.

`buildProject` pulls inputs in through five path-bearing keys, not one:
`deps`, `sources`, `includes`, `srcRoots` and `-I` compilerArgs. Four of them
can name a path outside the project directory, and when they do, that path was
in **neither** set the scan built. `vendor/cjson` is exactly that shape — no
`bin.json` of its own, compiled straight into five seeded binaries via their
`sources` — so editing `cJSON.c` changed five baked binaries while `boot.js`,
`serve.js` and `tests/lib/image-fixture.js` all read the blob fresh and reused
it.

That is the failure class worth naming: **an edit that silently does not take
effect**. Not a crash, not a red test — you change a file, everything passes,
and the change was never in the artifact. The 0082 gate exists precisely to
make that impossible, and its header comment told every reader it was handled.

## The fix

One new shared helper, `projectExternalDirs(proj, dir)`: the directories a
project's `sources`/`includes`/`srcRoots`/`-I` reach outside its own dir. Both
freshness scans consume it — `newestBakeInput` here and `newestPkgInput` in
`tools/mkpkg.js`, which carried the identical `deps`-only hole.

**Directories, not files, even for a `sources` entry.** That is the granularity
the rest of the scan already uses, and for the reason its comment already
gives: a quoted include resolves beside its source. `cJSON.c` includes
`cJSON.h` from the same directory, so file granularity would have left the
identical false green exactly one header away — a fix that passes its own
acceptance test and still ships the bug.

The `os` root keeps its runtime-only skip list wherever it is reached from
(gucman's `includes: [".."]` names it), so enrolling includes cannot smuggle
`os.html` back in as a bake input. There is a leg asserting that.

## Measurement, and why it argues for generality

Against the FAT manifest (`foldPackages(…, 'all')` — what the shared fixture
bakes), the fix enrols **exactly three new files**: `vendor/cjson/{cJSON.c,
cJSON.h,LICENSE}`. 5652 → 5655 files stat'd, 24 → 25 top-level vendor dirs,
scan 45 → 61 ms.

22 projects reach outside their own directory (full sweep recorded in the
ticket). Every target except cjson was *already* inside the closure, because
those projects also `deps` on a lib.json living in the same tree — freetype,
libpng, giflib, libgit2, netsurf all arrive that way. So the live blast radius
really was cjson alone, five times over.

Which is the argument for fixing the rule rather than the instance: cjson was
not special, it was just the one project that happened to reach out *without* a
dep alongside. The next one is a bin.json edit away, and it would be just as
invisible.

## The red control

`tests/host/test_bakeinput_sources.js` (host suite, ~1 s, no bake):

- **Leg A, synthetic tree.** A miniature repo in `tmpdir` — `newestBakeInput`
  is fully parameterized on `rootDir`, so this needs no fixture. One project
  whose `sources` and `includes` point outside its directory; touch each input
  and assert it becomes the newest bake input. Plus a negative: a file no
  project references must stay OUT, because a scan that invalidates on
  everything is not a freshness gate either.
- **Leg B, the real repo.** Instrument `newestBakeInput`'s `fsMod` (it takes
  one as an argument) and record every path it touches, then re-derive the
  manifest's project closure with an expander that shares no code with
  os-common — the `fsck.js` pattern — and assert the scan reached every
  escaping source and include. This is the standing sweep: a bin.json that
  starts reaching into a new tree tomorrow fails here rather than waiting for
  someone to re-audit.

On origin/main's `os-common.js`, **5 of 7 checks fail**, and leg B names the
five cjson consumers by hand. After the fix, 7/7.

Liability **L44** anchored the gap on the `vendor/cjson` rule comment in
`tests/run.js`; the sentence it cited is now false, so the comment is rewritten
(the row is derivable from bake-closure axis 1 now, not a hand-made exception)
and L44 is retired in the same commit.
