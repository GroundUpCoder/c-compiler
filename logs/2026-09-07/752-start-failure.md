# #752 — distinguish a failed image start from a runtime crash

At a921c483, both worker hosts posted every runModule rejection as `crashed`;
kernel.js mapped that to SIGSEGV. The existing onReady hook runs after the
Instance constructor, before main. Track that boundary and send `start-failed`
for earlier rejections; report normal exit127 to the parent and write the
reason through RemoteFS fd2 BEFORE teardown. This uses the existing spawn,
wait and descriptor machinery and works with child stderr redirection. A real
runtime trap still uses the crash path.

No blind retries: arbitrary wasm can execute a start section with side effects
before its constructor throws. The ticket permits correct completion or loud
failure. An unchecked shell script can ignore a nonzero status; a compiler
cannot infer intended files omitted from a glob. The build regression checks
every generator command and references all 40 modules so a missing one cannot
silently link a partial program.

Fresh evidence (build/status-fixes):
- RED218e28f9: 752-red-control showed forced Instance RangeError and LinkError
  both reaped as SIGSEGV. The first draft's JS octal syntax error is not a
  product red (752-red.log).
- 752-green: three newly executed kernel files pass. Forced failures give
  WIFEXITED/code127 and actual redirected diagnostic files; runtime divide by
  zero remains SIGSEGV, clean exit remains23. Existing trap delivery and
  process lifecycle tests pass.
- 752-build-rerun: one fresh kernel and one fresh browser file pass. The real
  40-module generation/compile/run produces TOTAL=35100 in both. Browser
  also forces the actual Instance constructor and checks exit127 and fd2.
- Initial build fixture used set-e and exposed hush exiting on the loop's final
  false condition. Xtrace in 752-build-diagnose shows i40 and no subsequent
  command. Explicit generator status checks are now used; this separate shell
  behavior is being isolated, not attributed to memory exhaustion.

Carried test rows are historical, not our execution. Under-load repeats,
standard flake and final aggregate full gate remain campaign obligations.
No merge or deployment has occurred.

Focused flake evidence: both new kernel files passed3/3 under load10.
Browser first run was2/3: all product assertions passed, but a warm-pool
route.fetch handler raced context disposal. The test now drains route handlers
with context.unrouteAll({behavior:'wait'}) before closing. Fresh rerun3/3 PASS
under load10 (752-browser-flake-rerun). Standard flake remains due.
