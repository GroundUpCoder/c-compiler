# Retire Rust/WASI and self-service runtime paths

Direct user request, 2026-09-21: remove Rust and ss support, clean the tree,
commit and push. This narrows the supported runtime surface around C/gucOS
and makes test ownership clearer for the C/SDL game-development work.

Removed the WASI adapter and alternate startup, ss helpers and dispatch,
and the kernel's ss module-cache exception. Removed Rust fixtures, browser
and kernel acceptance tests, the wc-rust package, and Rust producer flags
from packaging/serving. Retained the generic native-sibling seam for Clang.
Historical design docs moved to docs/archive with retirement notices;
existing archived source snapshots and historical logs remain intact.

Shared directory descriptors, filesystem identity, C Wasm-GC/reference types,
JS-string support, and C startup are retained. Mixed C/WASI identity tests
now exercise the C adapter; existing language-retirement tests verify the
removed namespaces fail at import resolution and producer flags are rejected.
Synthetic producer-scoping tests retain a fixture-only alternate producer.

Validation: direct retirement, stat identity (17 cases), and native base-purity
checks passed. Syntax and whitespace checks passed.
The initial local gate was interrupted during unit testing to remove stale
kernel timing entries/helper comments; it is not counted as a passing gate.

The completed `node tests/run.js --diff` selected 22 suites (not netsurf-patch,
disw, or sourcemap). Run ID: `20260921-112800-61727`, archived under
`build/test-run/history/`. Liabilities passed; unit: 850 passed, 3 skipped;
host: all passed; BlockFS: 15/15; Python compiler/project/library corpus:
890 passed, 111 skipped. Kernel selected files: 198 passed, 3 failed;
browser: 69/71 passed. Historical carried results are not additional coverage.
The completed gate is RED, not a merge/deploy certification.

Failures and follow-up:

- `test_os_boot.js`: 300-second spawn timeout during a full image bake.
  An isolated one-worker rerun with `CC_OS_BOOT_TIMEOUT_MS=600000` passed
  startup, shell/C compilation, persistence, upgrade, reset, and fixture
  installation/reuse assertions, but hit the outer 900-second file deadline
  during the final deliberately stale-fixture rebake. It remains inconclusive.
- `test_cpython_clang_e2e.js` and `test_clang_pkgs_e2e.js`: the sibling overlay
  publishes `/usr/bin/sameboy-clang` without a package definition here. Executing
  the unchanged `HEAD:tools/mkpkg.js` reproduced the same rejection. The prior
  `remove-small-integration.md` journal also records this mismatch and the boot
  timeout. No package-policy bypass or sibling change was made.
- `os-clang.mjs`: server startup exceeded its 300-second image-bake wait, both
  in the broad run and the isolated rerun. Preflight reaped the incomplete bake.
- `os-ui-lifecycle.mjs`: "hide left pixels" in the broad run; PASS on the
  isolated rerun (23.2 seconds), with no source changes.

The isolated dispatcher command was
`CC_OS_BOOT_TIMEOUT_MS=600000 node tests/run.js kernel sweep --filter=test_os_boot.js,os-ui-lifecycle.mjs,os-clang.mjs -j 1`.
Transcripts: `/tmp/rust-ss-cleanup-gate-final.log` and
`/tmp/rust-ss-isolated-rechecks.log`; the original run summary was also copied
to `/tmp/rust-ss-gate-summary.json` before the rerun.
External gucos-packages sibling tests and optional Dawn tests were unavailable
(sibling checkout / webgpu package absent).

Per the green-before-main rule, this change is committed and pushed on
`cleanup/retire-rust-ss`, without merging to main or deploying an image.
