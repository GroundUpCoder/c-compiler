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

## User correction: compatibility is the default

User clarified that actual Objective-C behavior should be followed as closely as
possible and questioned introducing GUCConstantString instead of NSString.
The assistant's proposal conflated a ticket boundary (no complete Foundation
implementation in #775) with a reason to diverge from Foundation conventions.
That inference was wrong; the public custom string-class proposal is withdrawn.
The earlier pending proposal is superseded, not approved as a bundle.

Compatibility is now the design direction: standard initialization behavior,
variadic methods using the existing C ABI, dynamic dispatch semantics preserved
through optimization, and an NSString-compatible constant-string seam. Full
Foundation remains distinct library work; compiler literal support alone does
not establish NSString API support. No implementation of these changes yet.

Primary-source check executed: Apple's String Programming Guide describes
`NSString *temp = @"Contrafibularity"`, Unicode string constants and program-long
lifetime; NSObject initialize documentation specifies first-message triggering,
superclass-first order, and inherited implementations being invoked for subclasses.
Sources:
https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Strings/Articles/CreatingStrings.html
https://developer.apple.com/documentation/objectivec/nsobject-swift.class/initialize()?language=objc

## First implementation checkpoint: static signatures and aggregates

Replaced the global single-signature slot with per-selector signature sets and
typed helpers. Static receiver lookup selects the nearest class declaration;
dynamic receivers reject incompatible visible candidates. Override and method
implementation declarations are checked for compatibility. Complete structs and
unions now use the C method-call ABI. Aggregate method parameters are marked
MEMORY, matching the ordinary C parser's callee-copy handling. The initial run
exposed the missing parameter storage mark with Cannot take address of REGISTER
variable 'a'; fixed the method parameter construction, without changing codegen.
Nil aggregate helpers explicitly clear every result byte before returning it.
Retired the aggregate absence checks and updated the override diagnostic check.

Executed `node tests/host/test_objc.js`: 14 positive executions (seven sources,
default and no-inline), 22 refusal checks, preprocessor/C-mode and multi-TU
refusal checks, C aggregate control all pass. `git diff --check` passes. This is
an intermediate focused checkpoint. Browser and broad gate have not run on it;
no independent review, push or merge has occurred for #775.

Still outstanding: distinct frontend object-pointer types; cross-TU class and
selector identities and ABI consistency; whole-TU dynamic ambiguity validation
(current candidate selection sees declarations available at the send site);
dispatch optimization; conventional initialization; NSString-compatible literal
seam; variadic methods; expanded acceptance, both OS hosts, full selected gate,
independent external review and final commit/push/merge. No scope reduction.

Complexity discussion: directly measured before this checkpoint, the integrated
experiment added 417 and removed 17 lines in compiler.js (43,274 current lines,
including bundled libc/headers). That is footprint evidence, not a percentage
of semantic compiler complexity. Assessment: moderate frontend/runtime extension
for round two; ownership automation/Blocks/exceptions would substantially expand
the maintenance surface. Foundation belongs in library code. No final LOC or
effort prediction was claimed.
