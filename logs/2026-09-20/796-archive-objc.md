# #796 Archive Objective-C

User explicitly directed archival into old/objc and removal from the active
compiler on 2026-09-20. This is authorized feature retirement, not a regression
against the previous Objective-C contract. Gamedev justification: remove unused
language complexity from the C/SDL toolchain while preserving useful C/host fixes.

Archived full compiler/host and integration snapshots, dedicated Objective-C and
Foundation sources/tests/package/design, with pre-removal commit and byte hashes.
Removed the compiler-specific patches in reverse chronological order, preserving
later graphics/UI changes and the earlier independent C aggregate/variadic fixes.
Removed host Objective-C guards and wrapper lookup; kept registration-time C and
Small callback capture, C Wasm EH, generic ctor invocation and async lifecycle.
Retired Foundation registration/package/tests. Moved the shared C compile helper
out of Foundation, and changed package-drift tests to the maintained cJSON library.
Bumped image version 295 to 296 for the package/compiler closure change.

Focused executed evidence: C/Small callback capture passes in JSPI and synchronous
modes; async lifecycle passes in both modes; source-library checks pass; retirement
and archive hash checks pass. Broad mapper-selected validation completed across the runs described below.
No deployment or installed-user-package removal has been performed.

## Final validation and scope

The first tool-session gate stopped without a completion record and is not a
pass. A detached second run completed all nonbrowser rows: todos, unit
(850 passed, 3 skips), host, BlockFS (15/15), Python-dispatched corpus
(904 passed, 0 failed, 111 skips), and all 209 current kernel tests.

The user asked for less frequent polling. I mistakenly interpreted that as
permission to narrow tests and stopped the browser sweep after five passes.
The user corrected me; I resumed all 69 remaining browser tests without changing
any staged source bytes. They all passed. The pre-resume manifest preserves the
five original passes; source SHA-256 verification covers the entire task snapshot.
No requested test coverage was dropped. Browser total: 74 current tests passed.

Raw kernel/browser manifests also carry two obsolete Objective-C/Foundation
entries each from earlier runs. These are excluded from the current counts:
kernel executed 209/209 freshly; browser executed 69 plus five same-source resumed
passes. Raw manifests and the interrupted dispatcher's nonzero verdict remain
unchanged. This is composed targeted-removal acceptance, NOT a claim that one
uninterrupted full/ship gate passed. No deployment is performed.

Evidence: build/796/gate-r2/summary.json (all nonbrowser rows pass; interrupted
sweep row), build/796/kernel-completed.json, browser-before-resume.json,
browser-completed.json, browser-resume-exit.json (exit 0), source pins in
state.json, and the independent current-membership audit in acceptance.json.
The archived original Objective-C core runner also executed successfully directly
under old/objc, and the active retirement test verified all 103 archive hashes.

Final diff whitespace check passed. Unrelated untracked projects/ and sedit
experiments were not added or modified.
