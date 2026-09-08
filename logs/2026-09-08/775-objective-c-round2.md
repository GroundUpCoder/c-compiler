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

## Successor checkpoint: variadic methods and declaration-order validation

Real serial successor 01a08074-581f-717a-88f3-4d0f50526df2, verified metadata
codex/gpt-6-astra, claimed #775 with force and reread. Independent external
read-only reviewer 01a08075-c875-7d8b-9af1-c85687c49d31 created through cc-meta,
explicit codex/gpt-6-astra and verified metadata; contract review in progress.

Added and executed a red variadic fixture (build/775/variadic-red.log). Implemented
per-call forwarding helpers with promoted argument types; their inner typed IMP
call uses C's variadic arg-block ABI, including aggregate arguments and results.
Whole-TU validation rejects later declarations that make an earlier dynamic send
ambiguous. Retired the variadic absence test. Focused Node run passes all 16
positive executions and 22 refusals plus existing controls
(build/775/variadic-host.log). Browser count updated but execution still pending.
No broad gate, push or merge in this checkpoint.

## Cross-TU checkpoint

The red three-TU fixture reached the original one-.m refusal. Replaced static
class declarations with external descriptors and selectors with external tentative
opaque objects named by spelling. Existing linker coalescing gives one selector
address across units, without a TU integer escaping as SEL. Added link-time class
layout and method ABI consistency checks, recursively inspecting aggregate shapes.
Retired the blanket multi-TU and interface-only implementation refusals.

Executed focused Node corpus: 16 original/mode positive executions, four three-TU
executions (both orders, both inline modes), 21 syntax/semantic refusals and four
cross-TU link diagnostics (layout, signature, duplicate, missing). All pass in
build/775/cross-host.log. Chromium cross-TU corpus added, execution still pending.

## #776 C prerequisite discovered by independent review

Reviewer source inspection suggested fixed-float corruption in indirect variadic
calls. Reproduced with a C-only volatile function-pointer control: Clang prints
3.75; at 051fcc8e our compiler reports invalid Wasm, f64.store receiving f32.
The first exploratory control put float last before ellipsis, which Clang warned
makes va_start undefined; corrected to an int last named parameter before using
it as evidence. Committed corrected red test as 9cd2e2f8. Filed/claimed #776,
contract C11 6.5.2.2p7, P0 light, necessary to #775's inner indirect variadic call.

Restricted indirect-call promotion to tail arguments, matching the direct path.
Executed corrected C control through emitted JS/Wasm: prints 3.75. Added an
Objective-C named-float+int+tail-double control to the shared fixture; focused
Node suite passes in both modes (build/775/float-objc-host.log). Fresh gate and
final review remain pending for both tickets. #776 adds no test registry entry;
its independent instrument is the named C conformance fixture, while #775 is
judged by Objective-C host/browser/OS acceptance.

## Object types, startup and dispatch checkpoint

Object pointers now have a distinct frontend subclass, preserving class name,
protocol qualifier set and ownership through const/volatile cloning. id remains
four bytes and is no longer void*. Added @class identities, protocol declarations
and inherited protocol qualification, id<P> and Class<P>* source forms; explicit
unsafe_unretained metadata carries manual lifetime while owning qualifiers refuse.
Tests cover typedef/field/parameter/return/conditional storage and protocol-based
signature selection despite unrelated conflicting selectors. Full protocol runtime
reflection is not claimed by these type-system changes.

An eager per-TU startup function roots every linked class; the linker emits the
existing host __wasm_call_ctors export to call them. Own +load implementations run
directly, superclass-first, without automatically invoking inherited +load or
triggering +initialize. Lazy initialization uses shared descriptor state with
active/pending/completed distinctions, inherited initializer calls per class and
pending-child completion for parent/child reentry. Instance and class sends
initialize the actual receiver class before lookup. A 16-slot per-descriptor cache
serves repeated selector lookup, with the existing superclass fallback on misses;
static receiver typing never selects an implementation. No method mutation or
module loader API is introduced.

Red eager-initialization control exited 1 (build/775/init-red.log); corrected its
unrelated-class order assertion by making Unused a subclass, so only guaranteed
superclass ordering is required. Focused Node corpus now passes 22 single-TU/mode
executions, four cross-TU executions, 22 refusals, four link diagnostics and AST
metadata controls (build/775/type-protocol-host.log). Browser execution, full gate,
final independent review and merge still pending. String literal lowering is next.

## NSString provider seam and focused Chromium execution

Red fixture refused @ string syntax (build/775/string-red.log). Added NSString*
literal typing with forward class identity and an external NSConstantString
provider. The compiler emits static payloads using modern GNUstep's 24-byte
wasm32 shape: isa, flags, UTF-16 length, byte size, hash, data. ASCII and UTF-16LE,
embedded NUL, supplementary pairs and adjacent literal concatenation are covered.
Linking validates the provider's complete inherited shape and names the missing
library dependency. No NSString method implementation or Foundation is bundled;
the test providers are explicitly ABI-only fixtures. Raw global payload arrays
needed MEMORY allocation marks, matching C array declarations; an initial compile
attempt diagnosed nonconstant payload address initializers before this correction.

Extended cross-TU tests with a provider in a different source, static Unicode
literal, superclass-first load, and a load-time send that triggers inherited
initialization. Both source orders and both inline modes pass in Node
(build/775/string-cross-host.log). Ordinary implementations may add method
declarations, including load/initialize without an own interface declaration.

Executed real Chromium standalone matrix. First run failed the Unicode literal
payload test (build/775/browser-focused.log): fixture scripts were served without
UTF-8 charset headers. Added explicit charset headers to the test HTTP server;
compiler fixture unchanged. The rerun exited 0 and records 51 cases: 24 single-TU
positive executions, 23 refusals and four cross-TU executions. Evidence:
build/775/browser-focused-utf8.log and build/objc/browser.json. This is a focused
browser run, not an OS or broad gate. The browser performed its own compilation.

New shared os-script.js prepares all 12 positive programs plus both cross-TU
orders for actual /bin/cc on Node/Chromium OS hosts (14 successful markers per
host expected). Both OS test drivers now use it, but those expanded OS tests have
not executed yet. README rewritten around implemented contracts and explicit
library/runtime boundaries. Fresh mapper-selected gate, standard flake gate,
Objective-C repetitions, final independent review and push/merge remain pending.

## Independent completed-source review corrections (318c5463)

Reviewer 01a08075-c875-7d8b-9af1-c85687c49d31 pinned 318c5463 and ran bounded
Node probes. Existing focused suite passed, but adversarial controls found real
gaps: a method-empty first interface hid later cross-TU signature conflicts;
partial superclass headers hid incompatible inherited overrides; static protocol
receivers ignored protocol-only methods; equivalent separately constructed id<P>
conditional arms lost object metadata; prefix unsafe_unretained Class* failed;
forward-only classes gained link dependencies under noFold. Reviewer also
independently reproduced U+FEFF literal stripping found in my own audit.

Added regressions and corrected the mechanisms. Linker signatures accumulate
all declarations, protocol requirements and static send contracts independently
of the selected layout/implementation representative; inherited overrides are
validated against that merged hierarchy. Protocol required implementations and
conversion guarantees are checked. Static method lookup includes explicit and
adopted protocols and is rechecked after the TU; protocol ancestry is traversed
from its declarations. Conditional expressions form an object-pointer common
type with shared protocol guarantees; cloning retains ownership/protocol context.
Prefix/suffix unretained qualifiers work on class pointers, including function
parameters. Forward declarations create runtime references only when used by a
class address or an implemented descriptor's ancestry. Literal decoding preserves
U+FEFF with ignoreBOM:true; byte accumulation avoids a call-argument spread limit.

Executed own BOM red (build/775/string-bom-red.log, exit4); added regression
212f875d before committing its correction. The other original adversarial reds
are independent reviewer executions, recorded in #775 comments; expanded local
Node corpus now passes all 26 positive executions, 25 refusals, 4 cross-TU runs,
8 negative link controls, metadata checks and noFold forward-only control
(build/775/review-complete-host.log). Chromium rerun awaits the heavy lock.
The shared OS script now expects 15 programs because protocol-only static dispatch
was added. No OS green or fresh broad Objective-C gate is claimed yet.

## Separate prerequisite gate, correcting the earlier batching plan

The #775 integration includes round-one registry enrollment changes. CLAUDE.md
3a.3 forbids batching such a ticket with another ticket, so the earlier plan to
share its gate with #776 was wrong. No combined gate was launched. Created isolated
lane/776-fixed-vararg-float from main 9db2c3cf, retained red-test authorship by
cherry-picking 9cd2e2f8, and split the C-only fix into fa602313. Its exact 25-suite
diff gate runs detached at /Users/jku/git/c-compiler-vararg776, wrapper PID 97146,
started 2026-09-08T10:33:45Z. Status/log/manifest files are build/776/gate.exit,
gate.log and gate/summary.json there. That worktree must remain stable while it
bakes/tests. Independent reviewer 01a08094-63e5-7c64-b622-e7f9d1e0ea50 was created
via cc-meta with explicit codex/gpt-6-astra and verified metadata; it APPROVED
exact fa602313 after a focused conformance run and native Clang control. The
prerequisite gate is still pending. Merge #776 first, rebase #775, then run its
own fresh mapper-selected gate and flake checks. Neither ticket is done yet.

Forward-qualified layout review regression: `ObjcClassType` now shares canonical
layout through qualifier views, including typedefs created while the class is
incomplete. The red acceptance was committed as 7e8d804c. After the fix,
`node tests/host/test_objc.js` passed (28 positive executions, 25 refusals,
four cross-TU executions and eight link diagnostics), recorded in
`build/775/forward-qualified-host.log`. Broader current-source gates remain pending.

The second independent review found two further cross-unit contract gaps:
protocol identity could hide different method schemas, and ordinary declared
methods could escape missing-implementation diagnostics. Red regressions in
d08eb85c reproduce the missing protocol check. Linking now compares complete
protocol schemas and resolves all declared methods through the canonical
implemented class hierarchy. Focused Node acceptance passes in
`build/775/protocol-link-host.log` (ten cross-TU refusal controls).

Conventional method variance now uses a directional Objective-C contract,
separate from C function compatibility: subclass/protocol-strengthened object
results and broader object parameters, with unchanged scalar/aggregate ABI
requirements. Linked contracts retain every caller declaration and compare the
actual implementation against each. Class hierarchy collection precedes checking
so source order does not change the result. Dynamic unqualified sends additionally
check linked selector candidates. The contract follows Clang SemaDeclObjC.cpp
`isObjCTypeSubstitutable` / `CheckMethodOverrideReturn` / `CheckMethodOverrideParam`:
https://clang.llvm.org/doxygen/SemaDeclObjC_8cpp_source.html .

The red variance program in 3d602a1a failed with incompatible override before the
fix (`build/775/variance-red.log`). Current Node acceptance passes in
`build/775/variance-linked-host.log`: 30 positive executions, 28 refusals,
12 cross-unit executions (including both link orders of covariance and C main
with Objective-C startup), 11 negative link cases and metadata/isolation controls.
Reverse/unrelated object returns and narrowed arguments refuse. The shared OS
script now includes 21 programs; its current expanded version has not yet run
on either OS host. Current real Chromium and broad gates remain pending.

Added a dispatch-cache execution control: eighteen selectors force collisions
in sixteen slots; alternating base/leaf objects through a base static type checks
warm-cache dynamic dispatch, inherited misses and lexical super. Focused Node
passes at unchanged compiler source (`build/775/cache-host.log`), now 32 positive
executions. The shared OS script contains 22 programs. This test-only extension
postdates the 211b46fd source review request; no compiler source changed.
