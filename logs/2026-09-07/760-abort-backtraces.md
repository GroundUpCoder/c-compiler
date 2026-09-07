# #760 — caller diagnostics before SIGABRT termination

The game developer's crash-diagnosis loop needs the callers of a failed
assertion, not only its predicate. At e6a1f4a6, libc abort calls raise(SIGABRT),
then __exit(134). Default signal delivery in __sig_deliver can already reap
that worker through __spawn_kill; reporting at __exit would miss the normal
kernel path. Inferring abort from status134 would also misreport exit(134).

RED d8b004d7 adds the shared call-chain fixture and a standalone-host fd2 test:
abort, assert and a returning handler lack their reports; plain exit134 and
closed-fd2 controls are correctly quiet. The fix adds a diagnostic-only
__abort_report import before raising the signal. It captures the live Wasm
stack and reuses the existing symbolicator/fd2 writer with an explicit
`fatal: abort` cause. It does not change signal dispatch, handlers, exit status
or atexit behavior, and the diagnostic cannot throw into the caller.

Initial focused evidence: 760-host-green.log passes all five modes, including
source lines derived from the fixture, complete noinline caller chain, existing
assert predicate, and absence of host-console leakage. The existing trap suite
also passes (760-trap-regression.log). Real OS kernel/browser validation follows
in 760-e2e on freshly baked image283. Full campaign validation remains pending.

The first OS invocation failed at boot: the freshly compiled ksvc blob also
imports __abort_report, but its deliberately explicit minimal loader env did
not provide it. Both kernel tests failed with the actual LinkError; browser
ready waits consequently timed out. This was an integration regression in this
change, not a flaky test. The loader now treats that import as a loud fatal
abort, consistent with its existing trap() entries for signals/process exit.
A kernel service has no process fd2 or signal lifecycle. The focused rerun adds
test_ksvc_e2e and rebuilds the fixture before trying both real worker hosts.

Final focused evidence: 760-e2e-rerun PASS, three newly executed kernel files
(abort, frame lifecycle, ksvc) and two browser files (abort, frame lifecycle).
Both real OS hosts deliver the full caller chain and source locations through
ordinary child `2>` redirection, preserve the assertion predicate/returning
handler, and keep exit134 quiet. 760-signal passes both existing signal unit
tests. 760-flake passes3/3 kernel and3/3 browser under load10; the browser
runs took3.2/3.4/3.6s. Carried artifact rows are not counted as fresh execution.

## Composed full-gate follow-up (2026-09-07)

The first fresh full run at022a212b exposed a stale unit stderr golden:
`stdlib/assert_fail` still expected only its assertion line, while #760 now
adds an abort report. The full log preserves this RED; it was interrupted
at the subsequent BlockFS leg and is not a completed full verdict.

The message contract is now checked in `test_abort_backtrace.js` using the
same unit C fixture: exact predicate/file/line, exact stdout, exit134, one
abort report and an unsymbolized frame with the missing-metadata explanation.
Only dynamic function indices/offsets avoid exact goldening. The unit corpus
keeps its stdout/exit checks; removing its obsolete stderr golden does not
remove the diagnostic assertion. Focused unit and host reruns pass.

The same full run's registry guard caught #764's host frame-lifecycle test
existing but not enrolled. Added it to the host member registry; standalone
execution passes its frame trap/drain/exit/quit cases. This was missing
validation enrollment, not a new claim of a product failure. The next full
run must execute the entire host suite, which the initial run refused.
