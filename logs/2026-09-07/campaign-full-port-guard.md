# Campaign full-gate port correction (#760)

The complete fresh full gate at `496ec960` exited 1 after 3280.4 seconds.
Kernel passed 199/199 files; browser passed 68/69. Its sole failing member,
`os-harness-unit.mjs`, identified port 3381 shared by the new abort-backtrace
and spawn-build browser tests. Unique member ports prevent a slow-closing
server from answering the next member's readiness check (#546).

Assign the abort-backtrace test port 3384, absent from the sweep's port scan.
This changes test setup only. The red run and child manifests are preserved
under `build/status-fixes`; fresh full validation remains required.

The dispatcher selects 26 suites but records eight result rows: nineteen
Python suites share one batch row. Validate the actual representation, not
the inherited checkpoint's incorrect expectation of 26 result rows.

After the correction, the actual harness-unit guard and the real Chromium
abort-backtrace member both exit 0. The latter exercises help, abort/assert,
returning SIGABRT handler and the `-g2 -fno-inline` caller chain on port 3384.
Logs: `full-port-guard-green.log` and `full-port-abort-green.log`.
