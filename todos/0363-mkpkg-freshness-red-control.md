# 0363 — newestPkgInput has no red control — the package-payload freshness gate is untested

- **Status**: open
- **Priority**: P1
- **Difficulty**: light
- **Design**: this file. Found by todos/0354 while fixing the twin gate.

## Goal

`newestPkgInput` (`tools/mkpkg.js`) decides whether an already-built package
payload in `dist/packages/` may be REUSED instead of rebuilt. It is the
package-side twin of `newestBakeInput`, and it is a false-green generator in
exactly the same way: when it under-invalidates, an edit to a package's source
silently does not reach the payload, and every downstream gate reports green
because the payload's sha256 still matches its (stale) index entry.

todos/0354 fixed the `deps`-only closure hole in **both** functions, but only
`newestBakeInput` got a test (`tests/host/test_bakeinput_sources.js`, which
covers the shared `projectExternalDirs` helper and the bake-side wiring).
`newestPkgInput`'s own wiring — and every other input class it enumerates
(`bin`, `text`, `c`+`hdrs`, `tree`, the clang overlay tier) — is exercised by
nothing. A regression there is invisible until someone notices a package that
did not pick up an edit, which is the failure mode that took 0354 months to
surface.

The obstacle is testability, not difficulty: `newestPkgInput` closes over a
module-level `const ROOT`, so unlike `newestBakeInput` (parameterized on
`rootDir`) it cannot be pointed at a synthetic tree.

## Plan

1. Parameterize `newestPkgInput` on its root — the `newestBakeInput` shape —
   or extract the scan so a test can drive it against a temp tree.
2. A red control in the host suite (`tests/host/test_bakeinput_sources.js` is
   the natural home — same subject, already fast): a synthetic package
   definition whose project's `sources` reach outside the project dir, plus one
   leg per input class the function claims to cover.
3. Keep the gate's documented NARROW scope intact: the os/ tree at large is
   deliberately not a package input (see the function's header), so a test
   must pin that too — over-invalidating here costs a rebuild of every package
   on every OS edit.

## Acceptance

- Each leg fails on a version of `newestPkgInput` with that input class
  removed, and passes on the current one.
- The scope pin from step 3 is a leg, not a comment.
