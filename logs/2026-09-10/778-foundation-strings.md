# #778 — real immutable Foundation strings (in progress)

User selected Apple UTF8String behavior: preserve lone UTF16 surrogates in
storage, return NULL from lossless UTF8 conversion. Design source review
01a08ad5-5eb0-7b51-8d47-e30372066adc and native Apple evidence informed NULL0,
byte-length, subclass and initializer contracts. No Unicode normalization or
host TextEncoder dependency. Existing win32/font codecs have different error
policies; the strict library codec lives beside actual NSString storage.

Implemented private UTF16 heap strings, real NSConstantString ABI provider,
constructor families, primitive-dispatched equality/hash/conversion, and
borrowed UTF8 storage with autoreleased ownership. Foundation tests now use the
actual provider instead of defining ABI fixture classes; standalone compiler
ABI tests retain their independent fixtures. Umbrella and source-library linking
supply the same implementation through Node and installed source namespaces.

## Evidence so far — not merge approval

All runs have manifests before child execution in build/778. Baseline
strings-baseline-red/20260910-101808-3686 failed because NSString.h was absent.
First implementation20260910-101954-3729 failed at runtime: isEqual: sent an
instance-only reflection method to a class object in this runtime. Fixed with
actual descriptor ancestry (class metaclass ancestry never matches NSString).
Failure remains preserved; focused20260910-102038-3780 passed all4configs.

Expanded Node runs: strings-integrated-node20260910-102327-4209 passed;
strings-codec-node20260910-102440-4360 passed87records; strings-oom-node
20260910-102556-4538 passed91records. Each configuration tests65536single UTF16
units and6144surrogate-pair boundary combinations; these are roundtrip/property
checks, not an independent native implementation oracle. Golden byte cases,
malformed encodings and Apple native observations supply separate checks.

Real Chromium strings-browser20260910-102727-4803 passed91records in7.1seconds,
sourceUnchanged, staged tree21a50f4b2d3fdc84f469937dd2e341deef122036;
portable manifest archived beside wrapper. Allocation tests cap Wasm memory,
exhaust real malloc, and verify constructor/UTF8-buffer failure cleanup. No
whole-gate, installed-OS or final stress result claimed at this checkpoint.

Exception temporary-storage cleanup and real NSException raising remain
required. #781 is the hard prerequisite; temporary stringError abort is
explicitly unmergeable. Independent reviewer01a0819e is assessing current source
and NSException contracts. Final source/evidence review, complete mapped gate,
stress and commit/push/merge remain. No deployment.

Installed-OS attempt strings-os20260910-102910-5025 was REFUSED by both heavy
runners at preflight: only2.5GB free (<3GB minimum). No OS test ran. Wrapper and
dispatcher preserve failure; no threshold bypass or green retry occurred.
No substantial abandoned harness fixture space was found. User asked to free
10–15GB or identify disposable data while implementation continues.

Real NSException source/header and a focused test are now drafted, using copied
name/reason and retained opaque userInfo per independent native observations.
They are not wired into the umbrella/library list yet. nsexception-language-
baseline-red20260910-103249-5543 preserves rejection of @try in both test and
implementation by pre-#781 compiler. This is unvalidated source, not completed
exception support. Bounded review01a08add-3105-70be-b4d8-4ff84e1bcdf4 identified
required exception cleanup in NSString temporaries and placeholder replacement.

## Real serial continuation 01a08ae3 — exception integration

Claim transferred and reread to actual external Codex/gpt-6-astra successor
01a08ae3-b444-7c7e-8812-32028620384a. #781 author also made a real tailcall to
01a08ae6-ef89-7135-8805-dfbd01b925c9; metadata verified. Independent reviewers
01a0834a and01a0819e remain separate actual external threads. The #781 aggregate
return snapshot assertion was not user authorization; its ticket body and author
successor now acknowledge native return-slot elision sensitivity.

Implemented lexical cleanup for decoded/copied UTF16 buffers, untransferred
UTF8 owners, constant placeholders and their concrete replacement receivers.
NSException now cleans its exact concrete string receiver when external source
primitives throw, in addition to completed snapshots and its own receiver.
Invalid nil UTF8/source arguments now raise actual NSInvalidArgumentException;
NULL/nonzero buffer failures are explicitly defensive extensions outside the
native pointer contract. Only bounds retains an explicit pending-name abort.
NSException is wired into the umbrella and source-library list. No #778 merge.

Lightweight integration used copied, hash-verified WIP #781 compiler/host under
build/778/eh-snapshot-20260910T104059Z, not a merged/approved compiler. Manifest
pins compiler443f8207943c33c4a2fd45f3636941d140f9957b3fb496e074e6d203ff9d831b
and hostcececad0b4b7fe12a626d353e5705172a89b6e62c7fc31b71d308433f558f2b6.
Persistent wrapper manifests precede execution and report unchanged source;
newer child manifests also hash the actual virtual library/test sources.

Executed evidence under build/778 (each directory contains run.json first):
- nsexception-first-integration/20260910-104123-6971: harness RED; wasm exit0
  emitted byte output, but the diagnostic runner joined Uint8Array as decimal
  numbers and missed the success marker. Preserved; corrected output decoding.
- nsexception-decoded-integration/20260910-104145-7033: PASS4 configurations.
- strings-exception-cleanup/20260910-104232-7310: flawed capacity-count test RED;
  coalescing/pool growth changed future allocation count. Replaced that metric
  with existing allocator inspection, measuring live allocated storage including
  block headers. The old failed source hash/output remain preserved.
- strings-cleanup-heap-accounting/20260910-104312-7396: PASS4 configurations,
  128 rounds each, with unchanged exact live storage and destruction counts.
- strings-cleanup-red-control/20260910-104330-7482: intentional virtual-source
  removal of both UTF16 finally frees went RED, live112 to42096. Control source
  preserved; no production source was reverted. This isolates their combined
  omission, not every individual guard.
- strings-core-with-eh-cleanup/20260910-104341-7500: PASS91 core records.
- strings-real-argument-raises/20260910-104535-7792: PASS4 configurations.
- strings-constant-exception-cleanup/20260910-104552-7817: PASS4, including
  catchable placeholder/replacement failure and stable live storage.
- nsexception-allocation-rollback/20260910-104635-7865: PASS4, each exercising81
  real available-space cases,57 nil failures and24 successes,81 exact receiver
  deaths and no live-storage increase. Only Wasm memory maximum was capped;
  real libc allocation and rollback ran, without host memory pressure.
- strings-integrated-exception-corpus/20260910-104820-8169: PASS103 records,
  including enrolled real exceptions, cleanup and allocation rollback. Cleanup
  now also covers a source length primitive throwing before buffer allocation.

Independent bounded review01a08aed verified earlier cleanup/evidence and found
the replacement receiver issue, already fixed in the newer snapshot. Current
library/tests are frozen for its rereview and factory-ownership assessment.
These tests are Node integration evidence only. New exception-enabled Chromium,
actual OS, mapped gates and final stress/review remain. The initial91-record
Chromium pass predates EH integration. Disk still blocks heavy runs; no guard
bypass, file deletion or deployment occurred.

Bounded rereview01a08af1 verified replacement cleanup and found the inherited
factory preparation leak. Actual red-first strings-factory-leak-red/
20260910-105212-8700 reproduced live112->4208 after128 root factory accessor
throws, using a new virtual test while production sources stayed frozen.

The final implementation boundary now consumes each library initializer's
receiver on failures during its own preparation, transferring responsibility
immediately before dynamic initializer delegation. Temporary buffers still
clean up after delegated throws. This fixes inherited factories without releasing
subclasses that already consumed themselves. NSException's former snapshot rescue
and the constant replacement rescue were removed in the same change to avoid
double release; the original constant placeholder still has its own cleanup.
The convention is explicit library MRC behavior, not a compiler-wide init rule.

strings-initializer-ownership-boundary/20260910-105414-9058 passed4 configurations:
1920 catches/config, source length/unit failure, root and primitive-only inherited
factories, custom initWithString dispatch, consuming delegated factories, nil and
successful replacement results with +0 autorelease lifetime, and exact liveBytes.
strings-corpus-owned-initializers/20260910-105430-9086 passed all103 records.
All use the same pinned WIP EH compiler/host. Current source/tests are frozen for
independent rereview; disk/bounds/accepted781/finalmappedgates remain pending.

Independent bounded rereview01a08af6-be72-71dd-b014-6cf68a9619ee found no new
ownership defect, verified unchanged source hashes and both current4/103-record
child manifests. It approves the bounded ownership correction as addressed,
not the WIP EH compiler, final backend gate or merge. Bounds/public failure policy
and accepted #781 integration remain open.

## Real continuation 01a08af9 — documentation and fatal-diagnostic coverage

Actual coordinator01a08af9-02a8-7462-95ce-7005a3139e51 verified Codex/gpt-6-astra;
claim transferred and reread. Library implementation remains unchanged from
bounded review01a08af6. README now documents string codecs/storage/borrowed
buffers, receiver consumption/delegation and real NSException's scoped API.
Retired string-absence liabilities L81/L83, kept collections L82 and enrolled
unresolved temporary bounds behavior as L84. docs-liabilities/
20260910-110304-31985 passed with live ticket checking and unchanged source.

Added string-diagnostic-exhaustion.m: exhaust real capped Wasm heap before an
invalid-argument initializer, require named diagnostic and fatal exit134 rather
than catch-all continuation. First corpus run strings-diagnostic-exhaustion-
corpus/20260910-110345-33217 passed107 records. Tightened shared corpus to assert
failureExit134, then strings-diagnostic-fatal-exit/20260910-110437-33428 passed107
records (integration-0V4cbY). All four fault cases actually exited134; neither
fixture refusal nor a catch-body return can satisfy this assertion. These runs
used the older104059 WIP snapshot, with immutable evidence preserved.

Author781 froze source-review snapshot review-1789038246257-sYrCGV. Verified all
snapshot source hashes and copied only compiler/host into new private
build/778/eh-snapshot-20260910T110609Z; originals and older snapshot preserved.
New compiler hash d3358365cd9b83b89fff85790be44982066f092463159429e89f4a610de3f6a9;
host8adaa9bb4123407afc77b122f6c4b40e41385708607ece69b8bb16ebab5cf032.
strings-frozen781-integration/20260910-110617-34675 passed107 records against
these newer bytes (childintegration-4kp0X8), sourceUnchanged=true. Includes four
1920-catch cleanup configurations,81 real allocation availability cases each
(57nil/24success), and fatal diagnostic exhaustion. These are actual Node runs
by this coordinator, not author-reported or browser/OS evidence.

Independent full781 source/design review request actually delivered to reviewer
01a0834a in operation01a08aff-7b79-71db-ad2f-d5a5faa63779; own wake registered.
Separate778 documentation/test bounded review delivered to reviewer01a0819e in
operation01a08afe-5557-7949-890c-127f6df2d877. Neither is final gate approval.
Bounds decision, disk headroom, accepted781, fresh backend/mapped/stress gates
and final review remain. Disk2.5GiB; no heavy job, deletion or deployment. Root
now also contains unrelated tracked changes and extra small-build files, observed
read-only and untouched; preservation extends beyond the older9-file inventory.

Bounded documentation/test review01a08b00-73d3-7824-9e41-d9bb7e7daf6b read in
full: no blocking defect, verified exact134 evidence and clarified that zero
recursive reporting calls follows source, not a call-count measurement. Added
the recommended WIP/#781 prerequisite immediately before README commands. No
implementation/test changes followed this review; final gate obligations remain.

## New async-host delta integration — 2026-09-10T11:27 UTC

Read full781source-ready01a08b10-4eb5-74b6-b869-9b06e85047f3 and verified all14
immutable snapshot source hashes, tracked.diff hash and five evidence hashes in
review-delta-bvlk5fcz. #782 is the new baseline-reproduced async completion P0;
its live ticket and781harddependency were reread, preserving777. Independent
reviewer01a0834a is assessing this delta; no source/backend approval inferred.

Copied frozen compiler/host into build/778/eh-snapshot-20260910T112637Z.
Compiler remains d3358365cd9b83b89fff85790be44982066f092463159429e89f4a610de3f6a9;
host is now9fdde15eed82c7a5fe46b58d04da8aaac26ce72a169223e2d240263c39b792ee.
Actual coordinator run strings-delta781-782-integration/20260910-112656-38292
passed107 records, sourceUnchanged=true; childintegration-zarmSf inspected after
its wrapper. This is new-host Foundation Node integration, not replacement for
async lifecycle tests, independent approval, browser/OS or final mapped gates.
Older source snapshots and results remain intact. No heavy window granted;
disk2.3GiB and pending user cleanup/bounds choices still block completion.

## Source approvals and stable-copy integration — 2026-09-10T11:45 UTC

Read full separate approvals78201a08b21-d663-7d2e-8d6c-c265396aad3f and
78101a08b21-ddc9-7030-99cb-61064bd8b719. These approve frozen source scopes,
not backend/stress/gates/merge. The reviewer independently closed both latest
termination failures in each separate tree; all earlier failures remain.

Copied source-approved dependent compiler d3358365 and hostb77acd25 into
build/778/eh-snapshot-20260910T114501Z with full SHA pins. Actual coordinator run
strings-source-approved781-integration/20260910-114514-40508 passed107 records,
sourceUnchanged=true; wrapper then childintegration-luhmit inspected. No new
Foundation source changes. This is Node integration on approved source, still
not accepted/merged781 or final Foundation backend validation. Disk2.1GiB blocks
separate782then781heavygates; no cleanup/threshold bypass or deployment occurred.

## 2026-09-11 — resolved bounds contract and focused verification

The user selected Apple's documented characterAtIndex: contract: indices at or
beyond length raise NSRangeException. The earlier native Mac observation of
NSInvalidArgumentException remains a differing historical observation; it is
not copied. This supersedes the earlier pending-choice entries above. Both heap
and constant strings now raise through the existing owned NSException helper,
with finally release and the existing fatal reporting policy if allocation fails.
Invalid-argument callers retain their original name and behavior. Active bounds
pending text and L84 are retired; dispatch optimization remains deferred.

The focused portable corpus adds empty/length/length+1/NSUInteger-max bounds for
heap, ASCII constants and UTF-16 constants, valid access after catches, exact name,
reason/userInfo, retained exception survival, lexical rethrow, finally execution,
receiver ownership and repeated allocator live-storage checks. A separate limited
heap control requires fatal134 and the named allocation diagnostic for bounds.

The first new fixture incorrectly expected exception escape to drain an
autorelease pool. That contradicts the existing #781 pool-exception-escape
contract. The preserved failures are fixture errors: the final fixture catches
the rethrow inside its pool, then checks retained ownership after normal drain.
No product pool/compiler behavior changed to accommodate the test.

Actual focused Node run (compiler d3358365, host e9d970a4) passed nine affected
programs in all four inline/GC combinations:36 records, including two required
allocation-reporting134 cases per combination; native runner exit0. Existing
strings, codecs, exception ownership/cleanup and exhaustion tests were included
because the shared raising helper changed. Full inputs, Wasm, Node identity and
raw results are retained in build/trap783/bounds778-focused-e5j5o8cm/.
Old accepted evidence keeps its original pins; no #782 browser controls or
per-ticket broad gate repeated. Final combined validation and landing are still
pending, along with review and transfer of #779 onto the real #778 commit.
