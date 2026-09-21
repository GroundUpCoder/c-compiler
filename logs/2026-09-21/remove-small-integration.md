# Remove Small-specific integration, retain gucOS

Direct user instruction: gucOS continues, but must no longer treat Small specially.
Removed the sibling snapshot installer, /bin/small compile dispatch, runtime
injection, Small-only return handling, image sidecars/freshness checks and dedicated
Small integration tests. Shared font, rendering, C callback and process facilities
remain. Browser image identity probes continue checking their relevant C artifacts.
Image version advances to 299 so persistent browser installations replace the
formerly bundled compiler/runtime. No image was deployed.

The Small repository independently removes its gucOS target/startup shim and
replaces Java C-ABI file/input/clock bindings with reference `small` bindings.
Historical logs and old/objc snapshots remain historical records.

Validation: syntax and diff checks passed. The required diff gate initially
refused before running because Playwright was drifted and the pinned Python venv
was absent. Restored dependencies using frozen-lockfile install and uv venv;
then restarted the diff gate.

Intermediate gate evidence: compiler unit tests passed (850 pass, 3 skips), all
host tests passed, BlockFS passed all 15 files, and the C project/library corpus
passed (890 pass, 111 skips). The rebuilt v299 image has neither /bin/small nor
/lib/small, while /bin/cc and /lib/fontbridge.wasm remain.

The kernel fresh-boot test hit its 300-second spawn budget while still baking
(the ordinary fixture bake took 325.1 seconds). This is an inconclusive harness
timeout, not a green result. An isolated rerun uses the supported
CC_OS_BOOT_TIMEOUT_MS=600000 override; its result is recorded below.

The kernel suite completed with 201 passes and three failures: the above timeout,
and test_cpython_clang_e2e.js / test_clang_pkgs_e2e.js, both rejected by mkpkg because
the sibling overlay publishes /usr/bin/sameboy-clang without a matching package
definition. No package-policy bypass or unrelated sibling change was made.

The full diff gate did not complete. Its browser phase first hit a shell-prompt
timeout and a 300-second Clang overlay build timeout. A late fontbridge README
cleanup then invalidated the base image (documentation is included in the input
freshness scan), causing repeated server-start rebakes. Interrupted the dispatcher
and stopped its orphaned builders; their temporary images were reaped by preflight.
The earlier image was atomically replaced by a successful 355.9-second rebuild.
The interrupted gate log is /tmp/small-gucos-removal-gate.log; the pre-existing
build/test-run/summary.json is NOT evidence for this interrupted invocation.

Focused browser rerun: all seven selected files passed — os-fontbridge,
os-renderclip, os-ui-lifecycle, os-abort-backtrace, os-boots, os-compositor and
os-clipboard. This confirms the changed browser probes and clears the earlier
base-image browser failures; it is not a 72-file sweep or a full gate pass.
Log: /tmp/small-gucos-browser-focused.log.

Extended fresh-boot rerun: PASS (exit 0), using
`CC_OS_BOOT_TIMEOUT_MS=600000 node tests/kernel/test_os_boot.js`.
Cold boot, shell/C compilation, persistence, upgrade, factory reset, forced
rebuild, fixture installation/reuse and stale-fixture recovery all passed.
Log: /tmp/small-gucos-boot-rerun.log. This resolves the original boot timeout;
it does not change the original kernel summary or certify the full diff gate.
