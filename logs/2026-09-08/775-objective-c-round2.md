# #775 Objective-C round two

Working thread: 01a07f3b-cff0-78e2-a61a-abe2b830d112, actual user-requested
tailcall from 01a07e90-5ed9-7617-afde-ad9dcf67ce5a. Read cc-meta metadata:
executor codex, pinned model gpt-6-astra. Claimed #775 and re-read its events
to verify the claim. No internal agents or external workers have been used.

Gamedev justification: carry application/editor code for an in-gucOS game
development workspace, and exercise #773's general aggregate ABI from Objective-C.

## Integration and executed baseline

Created /Users/jku/git/c-compiler-objc-round2, branch lane/775-objc-round2, from
main 9db2c3cf. Cherry-picked the full original experiment history, 90006741 through
94a12285, preserving commit authors and original journal records. New integration
tip da7771f9. No cherry-pick conflicts. The original experiment and main were not
edited; main's preexisting untracked files remain intact. Installed the required
two worktree node_modules symlinks.

Executed `node tests/host/test_objc.js` at da7771f9: all ten positive executions,
23 syntax/semantic refusals, preprocessor/C-mode checks, multi-TU refusal, and the
C-only aggregate control passed. This is a focused host result, not a broad gate.

## Red-first acceptance

Extended tests/objc/README.md with the round-two acceptance draft. Added
tests/objc/round2.js and wired it into both host and Chromium corpus runners.
Executed the two new positive sources individually: unrelated static receiver
signatures fail with the old one-signature-per-selector diagnostic; aggregate
methods fail with the old aggregate/reference refusal. Then executed the host
runner: its five existing default-mode positives pass before the new static
receiver fixture fails. Raw local output: build/775/red-core.log and red-host.log.
The Chromium runner was edited but has not been executed in this round.

## Material design choices awaiting user input

Read #775's full body/events, the round-one README/journal, source thread's
discussion, canonical repo documents, and SS-INTEROP.md's shared-memory/dlopen
design. No recorded decision found settling #775's four explicit open choices.
SS-INTEROP.md describes a future shared-memory loader; it is not evidence of
implemented Objective-C dynamic loading. Older CPYTHON.md no-dlopen statements
do not settle this newer Objective-C design question.

Proposed to the user: superclass-first lazy +initialize, explicit +load refusal;
immutable object literals through a custom GUCConstantString class; variadic
methods; fast dispatch retaining an open-world fallback for future class loading.
Actual dlopen and the ticket's named non-goals remain outside the proposal.
User input is pending; none of these choices has been implemented or represented
as accepted. This question is required by #775's decide-before-coding section
and the supplied AGENTS instructions on material unanswered design choices.
