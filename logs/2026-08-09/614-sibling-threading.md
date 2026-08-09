# #614 — comguc + serve.js sibling threading (design §7, follow-on 4/6)

Two repos, one seam. The #612 `--defs` machinery gets its first real callers:
comguc's build (sibling MANDATORY on the deploy box) and serve.js (the dev
origin's merged-index guard).

## The worktree trap is the design center

The naive `../gucos-packages` is wrong from a linked git worktree — it
resolves beside the *slug*, not the clone — and deploys build from exactly
such a worktree. `resolveSiblingRepo` (os-common) therefore resolves in
order: `GUCOS_PACKAGES=` env (returned VERBATIM, no existence check — an
explicit override that is wrong must fail loud at the caller, never fall
through to a discovered candidate, the cmdalt rule) → the MAIN clone's
sibling via the `.git` gitdir pointer (`<main>/.git/worktrees/<slug>` parsed
without spawning git) → the naive sibling. One implementation, consumed by
serve.js directly and by comguc through `createRequire` (scripts/sibling.mjs
is policy only), so the build box and the dev origin cannot drift.

## Where the ON-by-default policy lives (and where it does not)

comguc: mandatory (clang-preflight pattern; `--no-extra-packages` is the
explicit opt-out; `--image-only` runs no mkpkg and consults no sibling).
serve.js: resolves by default, guards the served /packages index — a present
index missing a sibling-defined package refuses naming the `mkpkg --defs`
fix; `--minimal` (the deploy shape) additionally demands the /packages half
exist; the fat shape warns loudly instead (dev boxes keep working).

Deliberately NOT default-on: mkimage/boot.js/image-fixture. The fat blob
stays a pure function of the repo tree — auto-folding a neighboring checkout
into the shared fixture would (a) break hermeticity and (b) set up a rebake
thrash between serve.js and the kernel-suite fixture the moment the sibling
gains a package. The fold capability exists (`foldPackages` opts.defs, #612);
*defaulting* it into the fat pipeline is #613/#615's call, when sibling tests
and migrated packages make the fixture genuinely depend on it.

## newestBakeInput opts.defs (the #612 lane's named carry-over)

Any baker that folds sibling defs must scan with the same roots or a fat
blob goes staleness-blind to sibling edits. `newestBakeInput` now takes
`opts.defs`: each root contributes its packages/ dir plus every definition's
closure resolved against THAT root (the newestPkgInput assetRoot rule).
Pinned both directions in test_bakeinput_sources.js: with defs, a sibling
source or definition edit is the newest input; without defs, the sibling
stays OUT (the scan and the fold must agree on the source list).

## Provenance

`build-info.json` grows `gucosPackages` ({commit, abbrev, dirty}; explicit
`{optedOut: true}` on an opted-out run — never absence-as-ambiguity), the
rich ledger gets the full repoState, and build.mjs verifies the SHIPPED
index covers every sibling-defined package (artifact over exit code — the
floor-gate rule).

## Open threads (named, not fixed here)

- comguc `lane-614` requires a c-compiler checkout carrying this seam
  (sibling.mjs names a pre-#614 checkout as the cause) — land the c-compiler
  half first, or together.
- The sibling `tests/manifest.json` `pattern` field stays #613's call.
- Fat-pipeline defs defaults (mkimage/boot/image-fixture) → #613/#615.

Tickets: #614 (this), #612 (the seam), #613/#615 (successors).
