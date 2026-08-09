# #612 — mkpkg definition-source seam: ordered `--defs` roots, union index

Design of record: `gucos-packages-second-repo-design-2026-08-05.md` §4B + §7
(option B, build-time merge — ruled 2026-08-09). This is the slice that makes
the `gucos-packages` sibling (#611) non-inert: package definitions, their
assets and their C sources can now live entirely outside c-compiler and still
build into the ONE `/packages` index.

## What landed

**One new concept: the ordered definition-source list.**
`os-common.packageDefSources(pathMod, rootDir, opts)` normalizes it —
c-compiler is the implicit source 0 (its pkgDir still overridable via the
existing `packagesDir` test seam), each `opts.defs` root a further source
contributing `<root>/packages/*.json` with every repo-relative asset path
resolving against THAT root. `findPackageDef` resolves a name to its owning
source. Threaded through, exactly the ticket's list:

- `listPackages` — enumerates the union; a duplicate name across sources
  throws LOUDLY naming both files, and the check runs BEFORE the producer-
  gating filter, so a `requires`-gated def collides too (whether the pair is
  visible to this enumeration must not decide whether the repo is
  well-formed). A silent last-wins would have let a sibling shadow a
  platform package — refusal is the design's §5e answer.
- `sourcePackageDefs` — a package unit derived from a `--defs` def carries
  `root` = the owning source, and its whole compile closure resolves there;
  the `-sources` companion of a sibling game mirrors the SIBLING's tree
  (design §5d).
- `newestPkgInput` — new `opts.assetRoot`: file entries (project/bin/text/
  c/hdrs/tree) and `extraInputs` resolve against the owning root; the
  toolchain inputs (compiler.js, mkpkg.js, os-common.js) still stat against
  rootDir, because whichever repo the definition lives in, the builder is
  c-compiler.
- `foldPackages` — takes `opts.defs`; a def owned by a non-implicit source
  folds with its asset paths REWRITTEN (`path.relative`, Node-only like the
  fold itself) so the folded manifest keeps its one contract: every path in
  it is rootDir-relative, and bakeSystemImage's ROOT-bound readers need no
  change. `text` entries inline as `content` at fold time. A sibling `c`
  entry refuses with a named fix (below).
- mkpkg (`tools/mkpkg.js`) — `--defs=<root>`, repeatable; loud preflight
  (missing root, root without `packages/`, the same root twice — an explicit
  request never degrades silently); `assembleTree`'s readers
  (readAsset/readBinary/buildProject/listTreeFiles) bind per owning source;
  the gate-validation loop and driftCheck walk every source; buildPackage
  and the freshness wrapper resolve the owner. Source-0 builds are
  byte-identical to the pre-seam behavior (same readers, same paths).

**Tests** (`tests/serve/test_mkpkg_defs.js`, registered in tests/host/run.js):
the §5d positive control — a COMPILED def + `bin` asset entirely in a tmp
source builds through `mkpkg --defs`, payload carries the wasm + asset bytes,
its `-sources` companion mirrors the sibling tree, a second run REUSES the
payload and a touched sibling source restales it; the collision red controls —
sibling-vs-sibling and sibling-vs-source-0 (a live repo name) both refuse
naming BOTH files, and a gated duplicate refuses on a plain enumeration; the
preflight refusals; and the fold leg — relocated project path really compiles
through a ROOT-bound `buildProject` (exactly the bake's binding), `bin`
resolves, `text` inlines, sibling `c` refuses.

## The invariant (ticket acceptance): client side UNCHANGED

gucman, the index schema, sha256 verification, deps, `minBase`,
`sync-defaults` and the storefront are untouched. Proof by diff — the commit
touches exactly:

    os/os-common.js               | the four seams above
    tools/mkpkg.js                | --defs + per-source binding
    tests/host/run.js             | one registry row
    tests/serve/test_mkpkg_defs.js| new
    logs/2026-08-09/612-defs-seam.md

No file under `os/gucman/`, no `os/software.c`, no C source at all, no index
schema field added or changed (`entryFor` untouched), no change to
`sync-defaults` or any boot path. The merge happens at build time; the client
still sees exactly one index on one origin.

## Decisions worth recording

- **Sibling `c` entries: build yes, fold no.** In mkpkg, ALL vocabulary
  resolves uniformly against the owning root (`c`/`text` against
  `<root>/os`), so a sibling `c` def builds and installs fine. In the FOLD,
  a `c` entry's staged-compile path is image.json vocabulary rooted in
  c-compiler's os/ tree, and rewriting it to a `../` spelling breaks the
  quoted-include staging (hdrs stage under mangled names). Rather than a
  silently-broken bake, the fold refuses loudly and names the fix: compile
  through `project` — which is also the sibling contract's stated compile
  vocabulary (gucos-packages README). Precedent: foldPackages already
  refuses postinst/prerm-carrying defs as install-only.
- **`text` inlines as `content` at fold time** — the fold is Node-only, the
  bytes are small, and it removes the only other os/-relative spelling from
  the folded manifest.
- **Duplicate refusal is file-level and pre-gating** — see above.

## Named gap for the follow-on threading ticket (design §9 ticket 4)

`newestBakeInput` (the FAT-fixture staleness scan) does not yet take
`opts.defs`; today no shipping caller folds sibling defs, so nothing can go
stale-blind. When comguc/serve.js/boot.js/image-fixture learn the sibling
default (`../gucos-packages`, loud preflight), that ticket must also thread
the source list into `newestBakeInput` — a fold without matching staleness
would make a sibling edit invisible to the fixture gate. Deliberately not
built here: it is caller territory and the ticket's function list is
explicit.

Also noted, not settled (it is #613's call): the sibling's
`tests/manifest.json` carries a `pattern` field; nothing in this commit reads
it.
