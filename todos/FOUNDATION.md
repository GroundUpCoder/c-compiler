# Small Foundation — #777 → #778 → #779

User-authorized work, 2026-09-08: real NSObject/manual ownership/pools,
then Unicode NSString with the existing NSConstantString literal ABI, then
real collections together with fast enumeration. Objective-C++ is excluded.
This document establishes the implementation design; it does not claim that
every implementation detail was user-selected or that any implementation passed.

## #777 design

The library belongs in `os/foundation`, with ordinary Objective-C source,
`Foundation/` headers, a `lib.json`, and a source-library package using the
existing include/source namespace mechanism. Node project linking and gucOS
header-driven source linking must both exercise the same implementation.
The compiler continues to own class layout, dispatch, selectors and startup;
the library owns NSObject methods and pool policy. Neither host nor kernel
owns object lifetimes.

NSObject adds no ivars to the compiler's root isa. Ownership storage must not
move descendant ivars: #775's constant-string ABI requires exactly 24 bytes.
The selected internal design, after independent source review, uses an
8-byte-sized prefix preserving the allocator's 8-byte alignment. The existing
runtime alloc/dispose primitives must use one matching prefix ABI across TUs.
The linker supplies one canonical immutable array of exact class, metaclass and
literal object addresses, built from actual DVar references and ordinary static
initializers. No constructor-time registration is needed, including before
+load. Compiler/library code does not mutate this array; Wasm memory is not
claimed to be protected read-only storage.

Before any prefix subtraction, an unsigned comparison with the existing
`__builtin(heap_base)` rejects heap addresses from immortal lookup in O(1).
Addresses below that boundary still require exact table membership; the boundary
alone must never classify arbitrary stack/global storage as immortal. Valid
non-immortal objects must come from the matching runtime allocator. Raw malloc
objects, forged pointers and use-after-free remain outside that contract. A
heap NSConstantString is mortal even though its class matches a literal's.
This discrimination is part of #777, not deferred to #778.

This avoids a per-allocation hash registry and its growth/rollback obligations.
Immortal lookups remain linear in the linked immutable address count; this is a
source-derived complexity statement, not a benchmark. The live table roots its
referenced literals during section GC, intentionally retaining those parsed
literal objects and payloads. Class liveness is already rooted by startup.
No 16-byte allocation alignment is claimed: libc malloc/calloc and aligned_alloc
currently support 8-byte alignment. Prefix arithmetic must be checked before
allocation, and disposal must free the matching allocation base.

Supported public subset: NSObject `+alloc`, `+new`, `-init`, `-dealloc`,
`-retain`, `-release`, `-autorelease`, `-retainCount`; `+class`, `-class`,
`+superclass`, `-superclass`, `-self`, `-isEqual:`, `-hash`,
`-isKindOfClass:`, `-isMemberOfClass:`, `-respondsToSelector:`, and
`+instancesRespondToSelector:` and `+isSubclassOfClass:`. Include explicit
class-side retain/release/autorelease/retainCount, self, isEqual:, hash and
respondsToSelector: because the runtime does not promote root instance methods.
Class objects are immortal with UINT_MAX as the retainCount sentinel.
These are real implementations. No zones,
copying, descriptions, proxies or runtime protocol reflection are promised in
this ticket. The later string/collection tickets establish their own API sets.

Allocation zeroes instance bytes except isa and creates one owned reference.
Allocation exhaustion returns nil; `+new` sends init to the allocation and
returns the initializer's result, including nil or a replacement object.
NSObject init returns self and imposes no custom initialization refusal.
Retain increments and returns self. Release decrements and sends the actual
receiver dealloc once at zero. Subclass dealloc releases its owned resources
and calls super dealloc last; only NSObject dealloc frees the allocation.
Manual ivar assignments perform no hidden ownership operations. Retain count
is diagnostic, not a substitute for tracking ownership. Invalid over-release
and use after destruction remain invalid program behavior.

NSAutoreleasePool supports `+new`/`+alloc`/`-init`, `+addObject:`,
`-addObject:`, `-drain`, `-release`, `-dealloc`. Initialization establishes
the current pool. Each registration schedules exactly one later release and
does not retain. Destroying an outer pool also destroys younger pools.
Draining must detach each entry before invoking user release code and keep
processing work appended reentrantly; user callbacks may create/drain nested
pools. Release order is unspecified to callers. Reentrant attempts to destroy
the pool already being drained fail with a named diagnostic and process abort in this exception-free subset.
Pool retain/autorelease are unsupported operations and must fail loudly;
Objective-C exceptions are outside this subset, so no exception behavior is
claimed. Pool storage exhaustion must fail loudly without silently dropping a
scheduled release. Missing-pool autorelease logs a warning and does not release
the object, following the conventional manual-ownership behavior.

`@autoreleasepool` uses the same library pool implementation. Its lowering
must drain on fallthrough, return, outward break/continue and outward goto;
evaluate a return value before draining; preserve gotos within the pool; and
reject jumps/case dispatch into an unentered pool. It must not turn the pool
into a synthetic loop which steals the application's break/continue targets.
Nonlocal C longjmp, process exit and traps do not promise scope unwinding;
Objective-C exception unwinding is not part of this subset.

## Public decisions confirmed

The user answered the specific scope/resource/misuse question: "Yes follow what
real objective c and foundation does" (2026-09-09). Implement the reviewed scoped
cleanup and diagnostic/process-abort policies within the exception-free subset.
Ordinary allocation still returns nil on exhaustion; missing-pool autorelease
warns without release. The internal storage choice remains an implementation
decision, not a claim that the user selected a particular metadata structure.

Independent external design reviews: thread
`01a0819e-9dcb-7bad-ba89-934f1f18d5bf`, metadata verified Codex/gpt-6-astra;
ticket comments `01a081a2-d031-789c-869c-d029efed9c16` and
`01a081a6-95d5-7d17-b578-b38cb55a4f4a`. They recommend the completed prefix /
exact-immortal-table / heap-bound fast path design, after correcting the
alignment claim. No implementation or tests were reviewed as passing.

## Acceptance instruments

Red-first shared programs exercise real NSObject subclasses, zero storage,
replacement/failing initializers, dynamic dealloc chains, nil sends, balanced
retains, multiple registrations, nested/outer pools and reentrant release code.
Separate failure controls cover allocation exhaustion and pool misuse/storage
failure. Cross-TU calls establish shared lifetime/pool state. Scope-control
tests cover both optimization modes, including aggregate return values and
negative entry jumps. No test ABI provider may be described as Foundation.

Run the library programs in Node, real Chromium and actual gucOS `/bin/cc`
programs on both OS hosts. Use the diff mapper for the gate, archive run-level
evidence before assessing child evidence, preserve reds, and serialize heavy
jobs. Independent source/evidence review precedes commit/push/merge completion.

Epic justification: real object lifetimes, Unicode text and collections let
Objective-C app/editor code participate in the in-gucOS game-development
workspace, and give language features actual library consumers.

Primary references consulted for this design:

- https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmRules.html
- https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmAutoreleasePools.html
- https://raw.githubusercontent.com/gnustep/libs-base/master/Headers/Foundation/NSObject.h
- https://raw.githubusercontent.com/gnustep/libs-base/master/Headers/Foundation/NSAutoreleasePool.h

Source observation at `5fb9f091`: `compiler.js`'s `objcInit` injects
`calloc(cls->size)`/isa and `free(object)` in guc_objc_alloc/dispose; there is
no reference count or pool state. The constant payload and linked layout
validator are already separate from those allocation primitives.

## #778 implementation contract (in progress)

User selected Apple-compatible strict UTF8String output on 2026-09-10:
preserve all stored UTF16 units, return NULL for unpaired surrogates during
UTF8 conversion. No replacement or normalization. Independent review
01a08ad5-5eb0-7b51-8d47-e30372066adc confirmed the small API and native Apple
NULL/zero-length and sizing behavior; native observations are distinct from
claims about guc tests. NSString is an isa-only cluster root; only exact-root
allocation redirects to private owned UTF16 storage. Arbitrary subclasses keep
their actual class and implement length/characterAtIndex plus, for inherited
construction, initWithCharacters:length:. Base init preserves the receiver.
This construction funnel is the supported guc subclass convention, not a claim
that Apple specifies one unique designated NSString initializer.

NSConstantString provides the existing 24-byte layout and permanent compiler
literal identity. Ordinary allocated constant-class initializers consume their
mortal placeholder and return an owned string. Shared equality/hash/conversion
use public primitives, not assumptions about subclass storage. Equality is
literal UTF16-unit equality. Hashes agree for equal contents across backing
representations; numerical Apple hash compatibility is not promised.

Selected API: string/new/init; UTF8String, characters:length:, string: constructor
families; initWithBytes:length:encoding: for ASCII1 and UTF84; length,
characterAtIndex:, UTF8String, lengthOfBytesUsingEncoding:, isEqual:,
isEqualToString:, hash and description. No copy/formatting/other encodings in
this increment. Input buffers are copied. Explicit byte counts preserve NUL;
C-string construction stops at NUL. UTF8 byte input consumes one leading BOM;
character arrays and compiler literals preserve FEFF. NULL buffers with zero
length produce empty strings. Unsupported nonempty encodings and malformed
bytes return nil; empty byte input needs no conversion. Sizing returns0 for
unrepresentable strings or sizes above NSIntegerMax, without a terminator.
UTF8String is borrowed, terminated, may contain embedded NUL, and may be backed
by a private autoreleased owner. Retaining the string does not extend that
owner past pool drain. No global scratch buffer or pointer-identity promise.

### Exception dependency — #781

The user's subsequent request for real exceptions supersedes treating an
abort-only policy as the final #778 contract. #781 implements the Objective-C
language/runtime EH substrate over existing Wasm EH. #778 then integrates real
NSException and catchable range/argument errors, including cleanup of temporary
constructor/conversion allocations when a subclass method throws. These are
required before #778 completion; current private implementation diagnostics are
not approved for merge. #777's historical exception-free scope is recorded
above, not silently rewritten. #779 collections remain after #778.

### #778 exception integration (unmerged)

The implementation now provides NSException with initWithName:reason:userInfo:,
exceptionWithName:reason:userInfo:, name/reason/userInfo getters, raise and dealloc.
It snapshots nonnil name/reason with real NSString construction and retains an
opaque NSDictionary pointer; this increment does not fabricate a collection.
Nil fields are preserved, and default init consumes the receiver and returns nil.
Ordinary construction exhaustion returns nil after releasing partial state.
The initializer's transaction describes fresh initialization, not a guarantee
about reinitializing an object whose old userInfo deallocation throws.

Invalid nil UTF8/source-string arguments raise real NSInvalidArgumentException.
NULL/nonzero byte/character buffers are outside the valid pointer precondition;
the catchable invalid-argument diagnostic for these is a defensive guc extension,
not observed Apple behavior (the preserved native probes crashed). Abstract
string primitives also raise NSInvalidArgumentException. If an exception itself
cannot be allocated, reporting terminates with a named diagnostic, without
recursively trying to allocate another exception. Bounds raise catchable NSRangeException for both heap and constant strings,
including empty strings and indices at or beyond length. The user selected
Apple's documented contract on 2026-09-11; preserved native Mac probes named
NSInvalidArgumentException, a differing observation that is not copied.

Library string initializers own their receivers during preparation. Failure or
throw during that phase consumes the receiver and frees local temporaries. Just
before delegating to another initializer, they transfer receiver responsibility;
after delegation they clean only their own temporary data. Thus inherited
factories cannot lose a receiver when a source accessor throws, and consuming
subclass initializers are never released a second time by the caller. Arbitrary
subclasses remain responsible for their own overrides and must follow this
library construction convention; this is not implicit compiler/ARC cleanup or
a claim about every Apple initializer. Direct callers must not release a receiver
already consumed by a failed library initialization.

NSException snapshots consequently need no duplicate receiver-rescue wrapper.
NSConstantString always consumes its original placeholder, while the separately
allocated replacement initializer owns that replacement. Borrowed UTF8 owners
are released on exceptional conversion or transferred once to autorelease on
success. In-flight exception lifetime belongs to #781, which remains a hard
unmerged dependency. Bounded independent review01a08af6-be72-71dd-b014-6cf68a9619ee found no new
ownership defect and verified matching focused/broader Node records. This is
not final backend, #781 or merge approval.
