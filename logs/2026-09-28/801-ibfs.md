# #801 — upstream IBFS directory indexing

The user asked to upstream wasm-posix d81420bc, run the required tests, commit,
push and deploy, and explicitly removed old-disk compatibility as a constraint.
The later instruction moved deployment to the previously configured machine;
this change supplies its committed source and deployment handoff instead.
The former directory helper bytes matched upstream b80908d1. This is a quality
improvement to source/header and asset lookups in the game-development loop;
POSIX behavior is unchanged.

The port removes the repeated directory scan, replacing it with a bounded,
store-scoped map plus sorted mutation index. It retains allocator/inode
read-through and invalidates before backing-store writes can partially fail.
The upstream-specific addition is NodeFileStore invalidation across live native
inode aliases, with listener cleanup on close. Existing single-writer boot locks
remain the process boundary. No parallel legacy scan implementation or migration
code was added; no user disks were deleted.

The new registered directory-index test passes for memory and OPFS wrappers,
v3/v4, native hard links, pathname replacement, raw and failed writes, read-only
views, eviction and warm lookup complexity. The full shipping gate is
`node tests/run.js full`, without filter or resume. Image version is 300.

Deployment is deferred to the user's configured machine; see docs/IBFS.md.
The intended path uses comguc's guarded publisher. Before this work, both the ledger
and production build-info named c-compiler 63950659 (2026-09-21). The package
repository will be carried from production for this filesystem-only image
release; package versions and contents are not part of #801.

The first full run found an environment setup mismatch: adding the mandatory
`gucos-packages` checkout exposed that the local development package index lacked
its two font packages. The server correctly refused to start. All 16 BlockFS
files had passed. That run was stopped before the remaining expensive suites;
its log and filesystem summary are preserved under
`build/ibfs-evidence/setup-failure/` (uncommitted test artifacts).

The published catalog and all 97 payloads were downloaded with size/SHA-256
verification, replacing only the local untracked development package cache.
`tests/serve/test_first_run.js` then passed. A fresh `tests/run.js full` run
started with stable dependencies and no resume. Optional Dawn dependencies were
installed before that run; live liability-ticket checks were enabled on PATH.

## Completed full gate — not green

Run `20260928-124633-34716` completed `node tests/run.js full` in 4,280.5 s
without filtering or resume. Liability checks, NetSurf patch checks, unit
(850 passed, 3 declared skips), host, all 16 BlockFS files, and all 18 Python
categories (898 passed, 111 declared skips) passed. The kernel executed all 203
selected files: 200 passed and 3 failed. Its summary additionally carries three
old results; those are not counted as fresh passes here. The browser executed
all 71 files: 69 passed and 2 failed. Both selected-member log checks passed.

Failures and attribution:

- `test_os_boot.js`: the deliberately uncached initial image build exceeded
  the 300,000 ms session deadline. Earlier fixture preparation measured 317.3 s.
  This is a harness kill, not a completed functional assertion.
- `test_cpython_clang_e2e.js` and `test_clang_pkgs_e2e.js`: the package drift
  guard rejected the local sibling overlay's unpackaged `sameboy-clang`. The
  local overlay was built July 11 from dirty clang-simplified 4048391, using
  c-compiler 5aa14b4. Existing #378 explicitly rejects packaging the old SDL
  frontend instead of the matching Win32 frontend; #136 owns that prerequisite.
  No stale package was added to silence this guard.
- `os-clang.mjs`: server readiness exceeded 600 × 500 ms while building the
  optional overlay image. A focused retry reproduced this; each left a temporary
  image that the next runner's preflight reaped. No completed overlay fixture
  or passing clang browser result is claimed.
- `os-ui-lifecycle.mjs`: first failed at the GPU vetoed-close pixel assertion
  (660 pixels; expected at least 20,000). Screenshot showed the window remained
  but its client area was black. An unchanged-source focused retry failed
  earlier at “hide left pixels”. Filed #802; causality is not established by
  either failure. Other GPU/browser checks passed.

The full dispatcher/child summaries, full log and failing logs are preserved
under `build/ibfs-evidence/full-attempt/`; the focused browser retry is preserved
as `build/ibfs-evidence/browser-retry{.log,-summary.json}`. These are local,
uncommitted evidence, not distributable build inputs. The committed handoff
requires a fresh full green release gate on the configured deployment machine.

The cold-boot retry used the supported `CC_OS_BOOT_TIMEOUT_MS=600000` with
`node tests/run.js kernel --filter=test_os_boot.js`. Initial cold boot,
compilation, persistence, upgrade, reset, fresh-system rebuilding, and fixture
reuse assertions passed. The final stale-fixture bypass required a third fat
bake, and the runner's separate fixed 900,000 ms file deadline killed it. The
retry therefore remains a timeout, not a pass. Evidence is preserved as
`build/ibfs-evidence/cold-boot-retry*`; existing #627 tracks this slow test's
budget problem. Increasing only the per-session environment budget does not
extend the outer file limit. No timeout or assertion was weakened in source.

A diagnostic then intercepted every browser `host.js` request with the exact
pre-IBFS b80908d1 file (six requests observed), retaining the current image and
other sources. It reproduced “hide left pixels”. This shows that this failure
does not require the IBFS browser directory index; it is not a complete
whole-tree baseline gate, and does not resolve #802. Evidence is under
`build/test-browser/ui-lifecycle-1790605188150`, with the diagnostic script,
baseline host and log preserved under `build/ibfs-evidence/`. The temporary
test file was removed.

Final source checks: JavaScript syntax, `git diff --check`, and the live
liability register passed. The implementation and image 300 are ready for
source handoff, but the full shipping gate is NOT green. No deployment was
performed and no old user disks were deleted.
