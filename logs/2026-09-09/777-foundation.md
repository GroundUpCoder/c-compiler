# #777 — real NSObject, ownership and autorelease pools

Continuation of completed #775. Author thread
`01a0819c-b7d6-7376-abbe-1383f124e496`, independently verified through cc-meta
metadata as Codex / gpt-6-astra. Worktree
`/Users/jku/git/c-compiler-foundation777`, branch `lane/777-foundation`,
base `5fb9f091f3ec81d179621d8fb8c59787002c4341`. The root clone's preexisting
untracked projects and sedit experiments were preserved. #777 claim was
reread as owned by this author. #778/#779 remain the authorized successors.

## Design and red-first preparation

Canonical docs read in full. The source confirms raw allocation currently
uses calloc + isa and raw disposal uses free; no ownership/pool state exists.
`todos/FOUNDATION.md` records the draft public contract and internal storage
alternatives. It is not a claim of user approval of detailed API decisions.

Independent external design reviewer `01a0819e-9dcb-7bad-ba89-934f1f18d5bf`
was created with executor `codex`, model `gpt-6-astra`; actual metadata was
reread and verified. Their review is ticket comment
`01a081a2-d031-789c-869c-d029efed9c16`. This was read-only design/source
assessment, with no builds/tests and no implementation approval. No internal
agents were used.

The review supports conventional manual ownership and an isa-only NSObject.
It requires trustworthy static-object discrimination before any prefix read,
one shared cross-TU runtime state, real scope cleanup if @autoreleasepool is
included, class-side immortal ownership methods, and precise negative tests.
A follow-up review assesses an exact linker-owned immutable address index as
an alternative to a runtime allocation side table. Follow-up comment
`01a081a6-95d5-7d17-b578-b38cb55a4f4a` recommends the completed prefix plus
exact linker-owned immortal table, using the source-verified heap-bound
negative fast path. That internal design is selected, with an 8-byte-sized
prefix preserving actual allocator alignment. At that preparation stage, the public decisions remained
pending. The design document was corrected accordingly.

The user was asked three unsettled public choices: include @autoreleasepool
normal-exit cleanup; diagnostic/process abort when pool bookkeeping or implicit
pool creation fails; and diagnostic/process abort for retain/autorelease or
same-pool recursive-drain misuse in this exception-free subset. At that stage these choices
were pending and implementation depending on them had not begun. Object allocation
nil on exhaustion and missing-pool warning/no release are the proposed
conventional baseline, distinct from obligation-storage failure.

Initial tests in `tests/foundation/` use real library headers, user subclasses,
initializer replacement/failure, destruction counters, nested/reentrant pools,
identity/reflection, and the scope-control matrix. They are preparation, not
passing evidence. The first compile failed on the absent Foundation header
(`build/777/red/ownership.log`, exit 1). A fresh manifest-backed red-first run
`build/777/red-first/20260908-152815-75146/run.json` independently recorded the
same failure, exit 1, from 2026-09-08T15:28:15.791571Z to
15:28:15.848656Z. The run manifest was read before its output log. No runtime
ownership assertion has executed yet. No implementation/gate/commit/push/merge
for #777 is claimed by this entry.

Epic justification: real object lifetimes, then Unicode strings and
collections, enable Objective-C application/editor code in the in-gucOS
game-development workspace and supply actual library consumers for language
features.

## Confirmed contract and implementation

The user subsequently answered: "Yes follow what real objective c and foundation
does." Ticket comment `01a08342-c4bc-7fa3-bdcb-ab347a1f17ef` records the confirmation.
Implemented the reviewed exception-free subset policy, including scoped normal
exits, named fatal pool failures, nil ordinary allocation failure and missing-pool
warning/no release. No further approval of those decisions is pending.

The compiler now owns matching allocation prefixes, exact linked immortal
identities and scoped cleanup lowering. The real NSObject and NSAutoreleasePool
implementations live in os/foundation, packaged through the existing source-library
namespace seam. There is no extra NSObject ivar and no host/kernel lifetime state.
NSConstantString providers in this ticket's tests are explicitly ABI fixtures;
real Unicode strings are the next authorized work in #778, followed by #779.

Independent source reviewer `01a0834a-4bfc-79cf-a974-4f4e93edaf28`, verified
Codex/gpt-6-astra, found no confirmed correctness blocker (ticket comment
`01a08350-b07e-79e2-a82c-b09e83fab3c2`). They independently executed the 67-record
corpus and 40 adversarial Node probes. An initial reviewer probe had an incorrect
destruction-count oracle; its original red and corrected pass are preserved in
build/review-777-01a0834a. This was source review, not final gate/merge approval.
Their aggregate snapshot and cross-TU literal controls were adapted into permanent
regressions, with attribution. Standalone Node and Chromium now create unique
attempt manifests before compiling and checkpoint failed records as well as passes.

The first focused actual-OS run passed: build/777/os-focus/20260908-231632-93800/run.json,
exit 0, dispatcher run 20260908-231632-93802, 238349 ms. Both selected Foundation
members ran fresh (kernel 1/201, browser 1/71, zero resumed/carried); this was a
filtered integration check, not a full gate. Each OS host compiled and ran 14
programs through installed headers/sources and /bin/cc. Chromium additionally
ran the portable 67-record corpus. Earlier failed author attempts remain under
build/777 (missing header, header directive syntax, retired absence assertion,
unused runtime prototype linking, diagnostic capture and browser require path).
The focused existing Objective-C host regression passed after those fixes.
Final mapper gate, stress repetitions and independent evidence review remain pending.
