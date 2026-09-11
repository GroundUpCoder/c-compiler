# #779 — owning arrays and genuine fast enumeration (unmerged)

Implementation author continuation: cc thread 01a08d63-3f91-7bfc-9160-6dc20661dce5,
verified executor codex/model gpt-6-astra, direct tailcall from author
01a08ae6-ef89-7135-8805-dfbd01b925c9. Existing independent reviewer remains
01a0834a-4bfc-79cf-a974-4f4e93edaf28. No internal agents performed work.
The ticket claim now names this successor; #778's dependency remains open.

Approved V1/V2 plan: manifests d9e989989ebf6fe75e3eecfeadd37dc32b84601081deb053b3665fc659ca97c0
and 876a568c4c7cb3e84115d5f96b17c77509dc6226f7cd301c2fa426b55f800fa2,
full independent design approval 01a08d60-98fc-7c13-bb81-f717a38460dd.
No additional design round was required for the settled choices.

The isolated lane starts at aeb8a5742374d6ec81edcfe4f5d86ed11e661874, an unpublished
preparation snapshot of frozen #778 staged tree dc928acf. That seed is not a
#778 completion commit and must not be shipped as dependency history. Only the
reviewed #779 delta is transferable after the real separate #778 commit, with
changed dependency bytes revalidated. The original batch index is not used here.

## Implementation

NSArray/NSMutableArray are class clusters with actual owning slot vectors.
Derived operations use public primitives. Initializer failures dispose acquired
slots and the unpublished receiver; retained candidates are revalidated against
current state after callbacks. Mutations detach/publish before release, and
removeAll detaches its whole vector so reentrant additions survive. Balanced
try/finally traversal releases all slots under ordinary throwing releases, with
later exception replacement inherited from #781. Concrete deallocation frees
storage and calls super in outer finally scopes.

Compiler for-in reuses the ordinary selector/signature/message helper seam and
lowers to one SFor before cleanup passes. It evaluates collection once, respects
returned itemsPtr, samples the first nonempty mutation token, refills on continue,
and assigns nil on exhaustion while preserving the last element on break.
Expression lvalues are reevaluated; MRC adds no ownership. Entry barriers reject
goto/case entry without introducing cleanup ownership. The conventional external
objc_enumerationMutation provider raises Foundation NSGenericException. The name
is supported by GNUstep source, not a claimed Apple-native observation.

Headers/source package, test membership, declared API boundaries and collection
absence documentation are updated. Image version 290 is preparation only, not
an image build/install/deployment claim. NSString bounds implementation is untouched.

## Actual focused evidence

Final collection run: `build/779/node-tF24Eq/run.json`, 55 passing records:
44 executions across both inlining and section-GC modes, including expected
status-134 mutation/capacity/allocation failures, plus 11 diagnostic controls.
It covers duplicate ownership, heap strings/pools, shallow copies, custom storage,
reentrancy, throwing retains/releases, generation exhaustion, multi-batch/nested
loops, nil/expression targets, transfers/finally overrides, custom provider,
missing provider, and cross-TU builds in both input orders. Wasm bytes and hashes,
compiler/host/input pins and failed earlier attempts are retained.

65,537-slot destruction executed in all four modes. The observed linear-memory
stack displacement was 32 bytes; captured Wasm stack samples counted 28–49 total
frames depending on mode/position. These are distinct observations: total frames
include generated/runtime/I/O frames, and neither is a native stack-byte measure.
The logarithmic source-recursion argument is not substituted for those samples.

Existing companions actually passed on the changed compiler/library bytes:
Foundation107 (build/777/foundation-node-1789079622205-nSQSnk), exceptions230
(build/objc781/node-1789079622214-81xM3u), existing Objective-C host corpus
(build/779/companion-objc.log), and async lifecycle's JSPI/synchronous child
modes (build/async782/node-1789079622220-LrPaoJ). Later edits to new array-only
fixtures do not claim those companion programs were reexecuted. A final source
comment clarifies recursion levels versus generated engine frames; executable
array source is unchanged from the final collection run.

The first focused attempt failed two test assertions that wrongly equated
separate string-literal object identities. Corrected to content equality or one
explicit shared exception object; original failing records remain in node-X9sL4o.
The initial ad hoc smoke omitted the host fs capability, failing import linkage;
its corrected invocation and limitation are preserved in initial-array-smoke.json.
No product failure is inferred from that missing harness argument.

## Remaining boundary

Source/evidence is ready for the existing independent reviewer. Prepared Chromium
and actual /bin/cc instruments are not executed: the OS fixture has ten programs;
the memory-capped allocator fault remains a direct-runtime instrument. No heavy,
browser, OS, main, deploy or cleanup grant was inferred. The mapper was dry-run
only. One final serialized combined gate covers #783 → #782 → #781 → #778 → #779;
no per-ticket broad gate is claimed or scheduled here. #782's disabled-browser
six unrun records and #778's pending strings bounds-name decision remain open.


## Subsequent focused validation and retained limits

The earlier remaining-boundary paragraph records the initial source freeze.
Source/Node review was accepted as 01a08d7c-5ab8. Node OS subsequently ran under
its separate serialized grant: one fresh kernel member of 206, ten ordered
actual /bin/cc programs, no resumed/carried results; native child and pane exited
zero. Image version290 was actually baked, with Small snapshot84107849.
Evidence audit0009fa34/innerd03ab722 was independently accepted01a08d8b-d4c8.

The first browser attempt failed before browser creation because the instrument
used a browser-package createRequire base for Foundation-local imports. Its
child and pane exited1, zero browser records ran, and failure7e2c8ea2 remains
red. The import-only correction uses a module-local require and a separate
Playwright package require; independently accepted01a08d90-f9bb.

A separately granted V2 run then passed55 portable records (44 archived runtime
Wasm plus11 diagnostics) and ten installed browser OS programs. Both Chromium
processes logged native exit0/signalnull/graceful close/temp cleanup; direct child
and retained pane exited0. Post-run process/listener absence was observed, but
exact serve PID/native exit was not retained and is not claimed. The full
audit a3aaf577 was accepted01a08d96-5d21. No backend repeat is needed at these
reviewed pins. Compilerbaf40333/hoste9d970 and the original77824/index remain
preserved; current779 source treeee493451 includes the import correction.

The separate782 capability diagnostic requested documented JSC_useJSPI=false,
dumpOptions=1 and validateOptions=true. Native launcher output printed those
settings, but the evaluating WebKit26.5 realm still exposed both JSPI APIs.
WebContent PID identity was observed; the option dump could not be attributed
to that evaluating process. Admission correctly failed, child/pane exited1,
browser launcher exited0 with cleanup, and zero fixtures ran. Audit36a57f73
was independently confirmed01a08da3-69dd as faithful failure evidence. All six
disabled-browser controls remain unrun; no host defect, universal WebKit
impossibility or coverage waiver is inferred.

Focused acceptance is not integration or landing acceptance. Real separate778
commit and reviewed779delta transfer/revalidation remain pending the strings
bounds decision. Preserve the unpublished snapshot seed and existing batch
commits; never publish the seed as778 history. One final combined broad gate
remains pending for the five-ticket batch; no deployment/main advance or manual
retained-server cleanup was performed.

## 2026-09-11 — actual dependency integration

The user selected documented NSString NSRangeException bounds behavior. The
independently reviewed #778 implementation is committed separately as
2138c720eca3fadee9541f527f39b36aa84f3e59. The unpublished preparation seed is not
part of that public dependency history. The original reviewed #779 export and
separately accepted journal patch were applied onto this actual dependency.
Only the liability hunk needed resolution: remove L82 while preserving #778's
retired L84. Active superseded bounds-choice text was updated without changing
reviewed array/compiler implementation bytes. Original exports and reds remain.

Actual integrated compiler baf40333/host e9d970a4 passed the 36 affected string
records and all55 array records. This revalidates changed Foundation inputs; it
does not relabel prior focused backend evidence. The six actual non-JSPI Firefox
controls were independently accepted at their own pins (audit1edf412f); no
repetition was needed for this library-only change. Their earlier unrun status
in historical entries above is superseded.

Integration evidence is under build/trap783/integrate779-hnep1m91/ and array
evidence under build/779/node-uGtd9C/. The
single final combined mapped gate and landing remain pending. Dispatch
optimization remains deferred until real workloads.
