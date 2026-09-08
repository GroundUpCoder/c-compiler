# #776 named float in an indirect variadic call

Discovered during independent #775 review by real cc thread
01a08075-c875-7d8b-9af1-c85687c49d31 (verified codex/gpt-6-astra).
Source-derived hypothesis was reproduced by implementation thread
01a08074-581f-717a-88f3-4d0f50526df2, also verified codex/gpt-6-astra.
No internal subagents. Contract: C11 6.5.2.2p7, fixed parameters keep their declared
types and default argument promotions apply only to the variadic tail.

At main 9db2c3cf the indirect variadic path selects the declared fixed float type,
then incorrectly promotes its storage to double. It emits an f32 expression to
f64.store, so the generated Wasm fails validation. The direct path already gates
that promotion on tail arguments. Fix both indirect layout/store selections to
follow the same condition. SP release/equality and aggregate-copy rules are unchanged.

The independent C regression uses a volatile function pointer so optimization
cannot replace it with a direct call. Its last named parameter is int, avoiding
undefined va_start use with a float last parameter. Clang reference prints 3.75;
the old compiler reports invalid Wasm (f64.store expected f64, got f32.const).
Initial red was executed in the #775 worktree and preserved in build/775/float-red.log.
The red-test commit 9cd2e2f8 was cherry-picked here with authorship retained.
Executed the fixed C control in this isolated worktree: generated Wasm prints 3.75.
Objective-C named-float coverage exists separately on the #775 branch.

This prerequisite initially shared the #775 development branch. That integration
includes test-registry changes, so CLAUDE.md 3a.3 requires separate gates. Isolated
here on lane/776-fixed-vararg-float from main 9db2c3cf before running any combined
gate. Gamedev justification: reliable function-pointer/variadic compilation is
required by app/editor code, and this existing C defect blocks #775's typed IMP
calls. Fresh mapper-selected gate and final independent review are pending.

The first fresh diff gate completed at source fa602313 with exit1, runId
20260908-103345-97148, elapsed3922923ms. The run-level record was inspected first:
25 selected suites, null filter, all executed via seven dispatcher rows (the
Python categories are grouped); kernel alone failed. Child manifests are complete
with no resumed/carried records: kernel199 (198pass,1fail), browser69pass,
BlockFS15pass. Python904pass/111 baseline skips with no skip-baseline violations.
The failed assertion is test_sedit_e2e.js's literal-colon filename marker. This
record is RED and retained under build/776/gate/history/20260908-103345-97148;
`build/776/gate-audit.log` records the manifest audit.

A direct same-source diagnostic rerun passed all16 assertions, including the
literal marker, exit0. It preloaded a build-only wrapper to retain driveBoot's
returned stdout/stderr; the test and its boot command sequence were unchanged.
Evidence: build/776/sedit-diagnostic.{log,stdout,stderr,json,exit}. The original
failure and this pass establish an intermittent result, not its mechanism or
whether product versus observation failed. The independent reviewer inspected
the first red read-only and likewise found insufficient evidence to call it a
timeout. No C or editor product source was changed in response.

Before a fresh gate retry, the failing test is running three repetitions with
two CPU-contention workers using the existing runner. The retry will start only
if these pass. Expected #776 acceptance remains the C conformance regression
passing (3.75, fixed float through a volatile variadic function pointer), with a
complete fresh mapper-selected diff gate and no reuse/resume of the red record.
Independent C source approval remains pinned to fa602313; this commit changes
only this journal. Current #776 is not ready to merge.

## Fresh retry completed green

Serial continuation 01a080d7-ee94-742a-8ee9-7e4f4be9359c (cc-meta metadata
verified codex/gpt-6-astra) transferred and reread both #776 and #775 claims.
Before the retry, the same-source sedit repetitions completed 3/3 passes under
two CPU load workers. This establishes intermittency, not a root cause.

Executed fresh `node tests/run.js --diff origin/main --out=build/776/gate2`
at 4b83e5470e379cee500ac46ef8cd6f5771d52452, compiler unchanged from approved
fa602313. Run 20260908-114234-43019 began 11:42:34 UTC and completed
12:32:21 UTC, elapsed 2,986,849 ms, exit 0. Inspected the newly published
run-level summary first: null filter, all 25 mapper-selected suites represented
by seven literal-pass rows. The diff tier deliberately omits netsurf-patch.
Then checked fresh child manifests: kernel 199/199, browser 69/69, BlockFS
15/15, done true, null filters, selected=executed=recorded=total, zero
resumed/carried, every file pass. Python 904 pass, 111 baseline skips, baseline
checked with no violations. Host health remained okay. The formerly failing
sedit member passed in 14.6s in this fresh broad run.

Evidence is build/776/gate2/summary.json and its immutable history archive,
gate2.log, gate2.exit, and gate2-audit.log. Original red and diagnostic logs
remain preserved separately; no source or test was changed to make it pass.
Final independent evidence assessment requested from the original C reviewer.
