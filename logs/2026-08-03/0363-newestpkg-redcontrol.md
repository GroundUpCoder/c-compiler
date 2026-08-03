# #144 (0363) — a red control for newestPkgInput

`newestPkgInput` — mkpkg's package-payload freshness gate, the twin of
`newestBakeInput` — had no test that could ever observe it failing: it closed
over mkpkg's module-level `ROOT`, and mkpkg.js is a CLI script that does work
at require time, so nothing could point the scan at a synthetic tree. An
under-invalidation there is the 0354 failure mode again: an edit that silently
never reaches the payload, green everywhere.

**Fix shape: extraction, not a require-main refactor.** The scan moved to
`os-common.js` as `newestPkgInput(fsMod, pathMod, rootDir, name, pkg,
{pkgDir, extraInputs, overlayPathFor})` — the exact `newestBakeInput` shape,
beside it in the file. mkpkg keeps a 6-line wrapper binding its CLI context
(ROOT, the `--packages-dir` override, the enabled siblings' overlay paths).
Restructuring mkpkg.js around a `require.main` guard would have been a much
larger diff for the same testability.

One deliberate scope addition while moving it: the scan now stats
`os/os-common.js` itself. It always produced payload bytes (packageControl,
buildProject seeding, listTreeFiles) and the original scan missed it; now it
also hosts the scan. Pinned by its own leg.

**The test** (`tests/host/test_bakeinput_sources.js`, 7 → 25 checks): one
synthetic-tree leg per input class the scan claims — definition, the three
toolchain files, project dir, `deps` recursion, out-of-dir sources (the 0354
hole), `bin`, `text`, `c`+`hdrs`, `tree`, sibling overlay, `extraInputs` —
plus both narrow-scope pins (an unreferenced os/ file and a referenced-by-
nothing file must NOT be inputs), a real-repo sweep (no shipped def's closure
may enumerate the repo root or os/ at large), and an entry-kind sweep (a new
`files` vocabulary word fails until it gets an input class AND a leg).

**Red verified both directions before landing.** Neutering six input classes
made exactly those six legs fail with the rest green (attribution works);
making the scan walk os/ wholesale made exactly the two scope pins fail.
End-to-end through real mkpkg: font-unifont builds cold, reuses fresh,
rebuilds after `touch` on its bin blob.

**Finding the sweep surfaced immediately:** `demos.json` legitimately walks
os/ — its `gpubox` entry's project is `os/gpubox.json`, and dir granularity
walks the project's own directory, which IS the os root. That's
over-invalidation of one package (the cheap direction), not the
every-package-restales hazard, so it's pinned by name in
`OS_ROOT_PROJECT_DEFS` with a presence check that fails when the exception
outlives its member.

Retires LIABILITIES.md L51 (its anchor was the removed `UNTESTED` comment —
the pre-commit hook caught the stale anchor before I did).
