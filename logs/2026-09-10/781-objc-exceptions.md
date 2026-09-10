# #781 Objective-C exception contracts and implementation journal

Author: external thread 01a08ad7-4198-7356-a65c-9c9c910750e9; continued by
01a08ae6-ef89-7135-8805-dfbd01b925c9 (metadata verified codex/gpt-6-astra).
Base: cee826008152435813358a49e9dc995d78b540bc. Worktree:
`/Users/jku/git/c-compiler-objc-exceptions781`, branch `lane/781-objc-exceptions`.
This is an implementation journal, not a completed-test or review certificate.

## Contract and source findings

Read CLAUDE.md, PRINCIPLES, GAMEDEV, OS, LIABILITIES, AGENTS and independent
design comments 01a0836d-868c-7377-b03f-0b315283aa33 (#777) and
01a08ad5-5eb0-7b51-8d47-e30372066adc (#778).
Epic justification: catchable model errors and reliable cleanup enable real
Foundation-based game editors and tools inside gucOS.

At the base, compiler.js:4895/4908 has STryCatch/SThrow; 20837–20927 emits
try_table, restores the linear stack, and captures an implicit catch-all exnref.
14009–14092 lowers pool normal exits after label resolution. 15598 unifies
exception tags by name in the linked parser registry. 8232 and 8342 flatten
EH regions for irreducible dispatch. Those paths must preserve lexical
exception identity, not just reconstruct a payload. host.js:13006 throws
ExitStatus for __exit; 13563 wraps its ordered kernel exit handshake.

Primary references actually read:

- [Apple language exceptions](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ObjectiveC/Chapters/ocExceptionHandling.html): arbitrary object throws, ordered catches, lexical bare rethrow.
- [Apple exception control flow](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Exceptions/Tasks/HandlingExceptions.html): finally on normal and exceptional control flow; unsupported longjmp crossing.
- [Apple runtime](https://raw.githubusercontent.com/apple-oss-distributions/objc4/main/runtime/objc-exception.mm): retained exception lifetime and class ancestry matching.
- [Clang pool contract](https://clang.llvm.org/docs/AutomaticReferenceCounting.html#autoreleasepool): no implicit drain on exception exit, including non-ARC.

Manifest-first native probe `build/objc781/native-001` compiled with
`/usr/bin/clang -fno-objc-arc -fobjc-exceptions -framework Foundation` and ran
with compileExit=0/executeExit=0. This is native Apple evidence, not guc evidence:

- Throw nil bypassed a typed class handler and reached id with nil.
- Runtime retainCount was 2 in the first handler; releasing caller ownership,
  nested replacement handling and reassignment of the catch variable did not
  destroy the original before lexical rethrow. Both objects eventually deallocated.
- Exception escape through a pool left its autoreleased object undrained.
- **Correction:** returning a local aggregate {1,2} then mutating its first
  field in finally returned {9,2} with default Apple Clang. The prior claim
  that the user authorized a divergent snapshot contract was false. Independent
  review 01a08adf established return-slot elision sensitivity: no-elide Clang
  returns {1,2}, while comma/global/compound-literal forms preserve {1,2} in
  every tested mode. Our non-eliding lowering preserves evaluation once before
  cleanup; the bare-local oracle compares to no-elide native behavior.

Manifest-first red Node probe `build/objc781/red-001` failed at the first @try
with the existing unsupported-expression diagnostic. Permanent source cases
started in `tests/objc/exceptions.js`; enrollment and positive evidence remain
implementation work.

## Concrete lowering design (review requested; implementation in progress)

One reserved linked tag carries an unsigned i32 record address. Record memory
is heap-owned and contains an object and reference count. Release uses dynamic
selector lookup; the earlier callback-field design was not implemented.
Throw evaluates once and allocates a fresh record; nil remains a real tagged
exception. Runtime retention/release uses ordinary object ownership messages.
Catch matching reads class descriptors and ancestors directly, never an
overrideable isKindOfClass:. id handles all ObjC records including nil; typed
classes do not match nil. Foreign C tags reach only catch(...).

STryCatch gains explicit exnVar bindings and tagged catch_ref. SThrow(null,
[exnref]) rethrows a lexical identity. The new internal reference type is never
an integer/object pointer and has no public C spelling. All optimizer and
irreducible transformations must retain these bindings and move them when
they move handler bodies.

Lexical cleanup scopes share the existing pool exit analysis. Each protected
scope lowers to ordinary AST with a pending completion discriminator and an
out-of-region cleanup label. Return operands snapshot once (aggregates in a
distinct memory temporary). Outward return/goto/break/continue first transfer
to cleanup, then resume the saved destination. Cleanup executes outside the
protected statement's own handlers, so a finally throw cannot re-enter them.
Finalizer directed exits replace pending completion. Entry goto/case dispatch
into try/catch/finally/pool scopes is rejected before normalization.

A catch owns the received record obligation. All exits execute its end-catch
cleanup; bare rethrow first adds the outgoing obligation, then cleanup drops
the handler's obligation. This preserves lexical identity after reassignment
and after nested handlers. A finally handling a propagating exception uses the
same obligation discipline, including override by return or replacement throw.
An unmatched typed handler forwards unchanged without taking a handler hold.
Pool scopes participate only in normal exits, preserving inner-finally-before-
outer-pool order and skipping pending pool cleanup when a finalizer throws.

The mixed C catch-all seam must recognize and consume ObjC records as well;
ordinary C handlers must not leak an object merely by swallowing its Wasm tag.
Export/startup boundaries terminate an uncaught ObjC record with a named fatal
diagnostic and release its record obligation. Record allocation failure takes
a nonallocating fatal path. Ordinary object allocation retains #777's nil policy.

Reserved __LongJump is guarded ahead of generic foreign handling: a local
setjmp inside the protected scope works; crossing ObjC EH fails loudly as an
unsupported crossing. Host exit requires a host guard before generic handlers
or finalizers: termination is not an eligible language exception. Traps remain
Wasm traps. These guards must cover both physical and irreducible EH paths.

## Validation still required

Expand/enroll Node and browser corpus plus actual /bin/cc on both hosts:
cross-TU/order/GC/inlining; lexical nesting; all directed exits and overrides;
ownership under pool activity; nil; ordinary foreign EH; C catch-all consume;
longjmp/host exit/trap separation; uncaught and capped-memory record failure.
Preserve all failures with a manifest written first and source hashes.
No heavy job, browser launch, OS boot or full build may run before the parent's
serialized window. Independent source/evidence review and mapper gate precede
commit/push/merge under parent coordination.

## Author continuation integration (01a08ae6)

The live ticket was reread before source edits, including independent review
01a08adf and coordinator correction01a08adb. Claim transfer to this actual
codex/gpt-6-astra continuation was executed and reread; historical works link
remains. No internal agents or root-tree edits.

Mixed C handlers are marked at source parse and instrumented once at link time,
including C-only TUs parsed before the ObjC TU. A typed internal rethrow extracts
the record from the same exnref; the original C handler is executed once and
uses the existing cleanup ladder for every exit. Runtime helper roots survive
per-TU pruning. C longjmp is preserved when such a handler owns no ObjC record;
active ObjC scopes still diagnose unsupported crossing.

Runtime new frees its untransferred record if dynamic retain throws. Runtime
finish consumes the handler hold, then resumes the pending completion. If
custom release throws, the replacement exception supersedes the pending one;
finish recursively consumes the replaced hold. This recursion is driven by
actual successive user throws, not unrolled synthetic code. Records are freed
before invoking release, so each record is consumed once even on that path.
Terminal uncaught cleanup recursively consumes replacement ObjC exceptions and
then exits134; allocation failure and unsupported longjmp use direct private
process exit, without calling user abort/signal handlers.

Wasm export wrappers forward the physical ABI unchanged and restore the entry
stack pointer on uncaught ObjC EH. Internal function/table indices retain the
original bodies. Address-taken functions additionally have private guarded
callback exports, used by host frame/async callbacks; C call_indirect continues
to propagate normally. Wrappers are emitted BEFORE dead-literal pruning: a
fatal test exposed zeroed diagnostic bytes when that pass preceded wrapping.
Host's private control latch excludes exit, wall-clock ceiling and SDL blocking
present refusal from user catches/finalizers. Genuine traps remain traps; a
foreign host Error rethrows with exact JS identity.

One catch-all source body is emitted once, outside typed/foreign dispatch,
which avoids duplicated label identities. Synthetic finalizer ownership scopes
are included when resolving labels inside finally. Backward-goto tests found
both issues and preserved the failing attempts.

Latest portable Node pass at this point:210 checks, manifest-first
build/objc781/node-1789038138348-hwrxzk/run.json, done=true. Four combinations
of noInline/gcSections plus forced irreducible cover arbitrary roots/class
objects, multi-TU both orders, C consumption, all return forms, typed/id/all
matching, lexical finalizer rethrow, backward labels, pool cancellation,
throwing retain/release, capped memory, startup/frame uncaught, host error
identity, cancellation/exit/traps/longjmp, and required diagnostics. Existing
Objective-C and Foundation Node runners also completed exit0 earlier in this
continuation (objc-existing-001.log / foundation-existing-001.log); those are
prior-source regression evidence, not final-snapshot gates.

Chromium and actual /bin/cc entries are enrolled, with per-run source manifests.
NONE has been launched in this continuation. Mapper dry-run selects25 suites,
excluding netsurf-patch. Parent window remains required; disk is2.6GiB free.
Independent source/evidence approval, serialized mapper gate, stress/browser/OS
results and commit/push/merge are still outstanding.

## Independent review blockers and #782 lifecycle repair

Independent frozen review01a08b04-e52a withheld approval: the host timer callback
failed as an unhandled rejection, and the new host test lacked explicit registry
membership. Both findings are retained; the initial snapshot is not rewritten.

The initial author C probe used the modified host and did not prove historical
presence. A subsequent probe extracted BOTH compiler and host from cee82600 and
reproduced plain C async exit134 as an unhandled ExitStatus, without runModule
settlement. Its observer exit73 is instrument status, not application status.
Evidence: build/objc781/baseline-async-r3v8k7i4/run.json. Filed P0 #782 and made it
an explicit dependency of #781; author claim and dependency were reread.

The host now owns timer callback synchronous throws and Promise rejections.
NO_EXIT_RUNTIME and frame lifetimes observe one failure channel. Terminal paths
cancel pending timers, unwind in-flight filesystem JSPI imports, and await the
existing GPU drain before returning/rejecting; failed drain never replaces the
original error. Filesystem suspension wrappers subscribe only while an import is
pending, so repeated successful sleeps do not accumulate listeners on an eternal
failure promise. Cancelling the suspension prevents Wasm continuation; the
underlying host operation may still finish (for example its sleep timer).
A terminal callback error also enters the private control latch so Objective-C
catch-all in a suspended entry cannot turn process termination into recovery.

Host registry now enrolls both test_objc_exceptions and test_async_lifecycle.
The latter launches actual JSPI-enabled and disabled Node children with strict
unhandled-rejection failure. Real C callbacks exercise successful callback work,
exit23, traps, exact host Error identity, pending callback cancellation, suspended
main/frame cancellation, and exactly-once drain completion despite an injected
drain failure. Injection measures teardown ordering, not a real GPU backend.
The portable ObjC corpus adds uncaught async callbacks during keepalive/frame
lifetimes plus async trap/host-error identity. Browser entry records page errors.
The first expanded corpus attempt failed at instantiation because its injected
SDL override omitted imports retained with gcSections=false; using the real null
SDL with only the host-error function injected fixes that test setup. The failed
manifest node-1789039180789-bofRSk remains intact.

These changes supersede the initial source snapshot and require independent delta
review. Lightweight evidence is separate from the still-unrun browser/OS/stress
and mapper gates. No heavy window or landing approval is inferred from Node passes.

## Second delta and separate #782 base

Reviewer01a08b13-5cb2 closed original blockers but reproduced C-only __catch
consuming suspension cancellation and a pending callback during normal-return
drain. Shared fixes now have a separate #782 worktree c-compiler-async782 on
lane/782-async-lifecycle from cee82600, with unchanged compiler. Native-trap
cancellation bypasses C/ObjC catches; owning host catch restores the original
reason by identity. Stop precedes terminal drain. See782 journal for contract.
The #781 host layer adds only ObjC guard and guarded callback lookup; compiler
and ObjC registry enrollment stay in its own scope. Prior snapshots/failed
probes remain intact. Superseding pins require independent review and serialized
backend gates. No approval inferred.


## Focused five-ticket batch integration (2026-09-11)

Direct user cadence exception groups783/782/781/778/779 behind one final
combined broad gate. Integrated onto0845ad42, preserving Small and783/782.
Original dependent patch applies to compiler/host unchanged; registry context
had moved with Small enrollment, so both original entries were retained and
ObjC entries added adjacent to Foundation. No compiler algorithm redesign.
Actual integrated Objective-C corpus and async lifecycle, Small execution,
captured-stack, trap/abort/frame companion checks all pass under Node.
Current evidence: build/trap783/integrate781-51assht8/focused.json.
Browser/OS exception checks at current781 pins, current778 strings cross-layer
checks,779 collections, and final batch broad validation remain PENDING.
Historical782 browser admission remains failed13pass/1modefailure/6unrun;
it is not current781 browser evidence. Original snapshots/reds stay preserved.
