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
