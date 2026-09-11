# Small Foundation: objects, strings, exceptions and arrays (#777–#779)

This is a real Objective-C source library for gucOS's static-link, single-threaded
Wasm runtime. It provides NSObject, NSAutoreleasePool, scoped autorelease pools,
immutable NSString/NSConstantString, NSException, NSArray and NSMutableArray. It does not claim full
Foundation or Apple/GNU runtime binary compatibility.
Arrays implement the NSFastEnumeration protocol and genuine compiler `for-in`.

The #778/#779 batch awaits final combined validation and landing. Focused
source, Node and browser/installed-OS evidence has its own recorded input pins;
API documentation below is not a final gate or landing acceptance record.

On a minimal gucOS image, install the source library with `gucman install
foundation`; the fat development/test image includes it. Then:

```
#include <Foundation/Foundation.h>
int main(void) {
  @autoreleasepool {
    NSObject *object = [[NSObject new] autorelease];
    if (![object isKindOfClass:NSObject]) return 1;
  }
  return 0;
}
```

Save this as `main.m` and run `cc main.m -o example && ./example`. The header
requires the real `.m` sources through the ordinary source namespace. For Node:

```
node compiler.js -Ios/foundation --srcroot foundation=os/foundation main.m -o example.js
node example.js
```

A Node `bin.json` can instead depend on `os/foundation/lib.json` using a path
relative to that project. Both routes compile the same library source.

## Supported API

`NSObject.h` is the exact declaration list. NSObject supports allocation/new,
initialization/deallocation, manual retain/release/autorelease and diagnostic
retainCount. Identity/reflection includes class/superclass/self, pointer-identity
equality/hash, instance kind/member predicates, subclass predicates, selector
response queries and instancesRespondToSelector:. Class-side identity and
ownership methods are explicit implementations; class objects are permanent.
BOOL is signed char, NSInteger is int, NSUInteger is unsigned int on wasm32.

`+alloc` zeroes instance storage except isa and returns one owned reference.
Exhaustion returns nil. `+new` dispatches alloc then init and returns the
initializer's result exactly, including nil or a replacement object. NSObject's
init returns self; subclasses manage their own initialization and replacement.
Retain acquires another reference and returns self. The final release sends the
most-derived dealloc. Subclasses release owned resources and call super dealloc
last; NSObject dealloc frees the allocation. Clients use release, not dealloc.
There are no hidden retains/releases on ivar assignment and no cycle collector.
Retain count does not include pending autoreleases and is not an ownership oracle.
Count overflow or release/retain of a live zero-count object aborts rather than
wrapping. Use-after-free, forged pointers and resurrection are invalid.

Compiler-provided class/metaclass objects and literal objects are permanent:
retain/autorelease return self, release and raw dispose do nothing, retainCount
is UINT_MAX. A heap instance of the same class remains mortal. This library
supplies the real NSConstantString provider for the compiler's 24-byte literal
ABI. Separate compiler tests retain independent ABI/provenance fixtures.

## Autorelease pools

Each initialized pool becomes current within its Wasm instance. Registration
adds one deferred dynamic release, without retaining or immediately releasing;
repeated registrations are distinct ownership obligations. `+addObject:` uses
the current pool; `-addObject:` uses the receiving pool. Nil adds nothing.
Missing-pool autorelease warns on stderr and leaves the object unreleased.
There is no implicit pool around ordinary main.

Both drain and release destroy a pool; drain is not a reusable empty operation.
Destroying an outer pool also destroys younger pools. Release order is
unspecified. Objects autoreleased by deallocation callbacks are also drained,
including objects in child pools created by those callbacks. Finite reentrant
work is processed to completion; infinitely self-producing callbacks need not
terminate. Pending entries are removed before user release code runs.

Retaining or autoreleasing a pool, recursively draining the same pool while
its drain is active, and registering with an uninitialized pool diagnose and
abort the process. Failure to allocate registration bookkeeping or a scoped
pool likewise diagnoses and aborts: a promised deferred release is never
silently dropped or performed early. These existing pool misuse/resource paths
retain their diagnostic process-failure policy; they do not promise a catchable
Foundation exception.
Ordinary explicit pool allocation still returns nil on exhaustion.

`@autoreleasepool` uses the same implementation and drains on fallthrough,
return, and break/continue/goto leaving its scope. Return values are evaluated
before cleanup, including aggregate values. A goto within the scope does not
drain. Entry by goto or outer-switch dispatch that bypasses pool creation is a
compile-time error. Explicit and scoped pools can nest with balanced lifetimes;
do not destroy a scoped pool indirectly by manually draining an enclosing pool
before its lexical exit. C longjmp across live pools, process exit and traps
provide no automatic scope unwinding. Objective-C exception escape likewise
does not drain an autorelease pool; use an explicit ownership strategy when
catching outside its scope.

## Immutable Unicode strings

`NSString.h` declares the supported subset: empty/string/UTF8/character-array
construction, explicit byte construction, length, characterAtIndex:, UTF8String,
lengthOfBytesUsingEncoding:, equality/hash and description. Constructors copy
input. `+string...` returns an autoreleased object; `alloc/init...` and `new`
return one owned reference. A mortal NSConstantString initializer consumes its
placeholder and returns an owned replacement string.

Length and indexing count UTF-16 code units, including embedded NULs and unpaired
surrogates. A supplementary character counts as two units; these are not grapheme
indices. Equality compares literal units without normalization. Equal strings
have equal hashes across representations; numerical Apple hash compatibility
and stable hash values across library versions are not promised. Description
returns the string itself.

Only ASCII (NSASCIIStringEncoding) and UTF-8 (NSUTF8StringEncoding) byte codecs
are supported. Malformed bytes and unsupported nonempty byte encodings return
nil; zero-length byte input creates an empty string without conversion. UTF-8
byte input consumes one leading BOM; character arrays and compiler literals
preserve U+FEFF. Explicit lengths preserve embedded NUL; C-string construction
ends at the first NUL. NULL with zero explicit length is empty.

UTF8String returns NULL for an unpaired surrogate or allocation failure, without
replacement, WTF-8 or CESU-8 output. Its borrowed, terminated buffer may contain
embedded NUL and may use a private autoreleased owner: retaining the string does
not extend that buffer beyond pool drain. Copy bytes that need a longer lifetime.
Byte sizing excludes the terminator and returns zero for an unrepresentable
string, unsupported encoding or result above NSIntegerMax.

Nil UTF8/source-string arguments raise NSInvalidArgumentException. NULL buffers
with nonzero length violate valid-pointer preconditions; this implementation's
catchable invalid-argument diagnostic is a defensive extension, not a promise
about arbitrary invalid addresses. Other invalid addresses remain undefined.

characterAtIndex: raises a catchable NSRangeException when the index is at or
beyond length, for heap and constant strings, including empty strings. This
follows Apple's documented contract, selected by the user on 2026-09-11.
Preserved native Mac probes reported NSInvalidArgumentException on that release;
that differing observation does not define this implementation's behavior.

NSString is an isa-only class-cluster root; exact-root allocation selects private
owned UTF-16 storage. Subclasses supply length and characterAtIndex:, and supply
initWithCharacters:length: to use inherited construction. Base init preserves
the receiver. Abstract primitives raise NSInvalidArgumentException.

Library initializers own their receiver during preparation: nil/failure/throw
consumes it and frees local temporaries. Immediately before dynamic delegation
to another initializer, receiver responsibility transfers to that initializer;
outer cleanup then frees only its own temporary data. Direct callers must not
release a receiver already consumed by failed library preparation. Subclass
overrides must manage their own initialization and replacement using this
convention. It is a library convention, not implicit Objective-C or ARC cleanup.

## NSException

The supported API is exceptionWithName:reason:userInfo:, initWithName:reason:userInfo:,
name/reason/userInfo, raise and dealloc. Construction snapshots nonnil name/reason
with real string construction and retains userInfo; getters return borrowed
objects. Nil fields are preserved. Plain init consumes the receiver and returns
nil. Fresh construction rolls back partial state on exhaustion or exception;
ordinary allocation exhaustion returns nil. This transaction does not promise
safe reinitialization when old userInfo destruction throws.

NSDictionary is only forward-declared here and is outside this array subset. NSException does not supply a placeholder collection. Raise uses real
Objective-C @throw and runtime exception ownership from #781. String diagnostics
release their own exception reference as it propagates. If the diagnostic
exception cannot itself be allocated, reporting terminates with a named message
without recursively allocating another exception.

## Owning arrays and fast enumeration

`NSArray.h` declares the exact supported methods: empty/single/buffer/array
factories and initializers; count/index/first/last queries; contains/equality/hash;
copy/mutableCopy; capacity initialization and individual insertion/removal/
replacement/removeAll for mutable arrays. Every stored slot owns one retain,
including duplicates; getters borrow. Factories autorelease; init/copy/mutableCopy
return owned objects. Copies are shallow independent containers except exact
private immutable copy, which retains self. Hash is count, with collisions.
No NSCopying/copyWithZone protocol or general NSString copying is claimed.
Variadic constructors, dictionaries/sets, sorting/Blocks, collection literals,
subscripting, serialization and thread safety are outside this declared subset.

Nil elements raise NSInvalidArgumentException. Indexed access/removal/replacement
requires index below count; insertion allows index equal to count. Violations
raise NSRangeException. NSString bounds also follow the documented NSRangeException contract. Nil initWithArray source is invalid; empty first/last is nil.
Capacity is only a hint. Checked vector overflow/allocation exhaustion terminates
with `NSArray: allocation or capacity exhausted`; ordinary object alloc still
returns nil on exhaustion. Reinitializing a concrete receiver is rejected without
changing its state. A failed fresh initialization consumes its receiver.

The public classes contain no storage ivars. Exact root alloc selects private
concrete storage; subclass alloc preserves the dynamic class. Custom immutable
storage must supply count/objectAtIndex, init/initWithObjects:count:/initWithArray:
and dealloc. Mutable storage additionally supplies initWithCapacity:, insertion,
removal, replacement and enumeration with a stable mutation token. Abstract
operations fail loudly when required overrides are absent. Derived operations
use public primitives. Generic immutable enumeration uses a per-state stable
counter under an immutable-content contract; subclasses which mutate must supply
their own tracking. Generic mutable removeAll uses removal primitives and does
not promise reentrant snapshot semantics; custom storage must override it for
that guarantee.

Private mutation publishes valid state before releasing removed elements. Retain
callbacks may reenter: index, current occupant, capacity and generation are
revalidated after retain. An invalidated index releases the candidate hold and
raises; earlier reentrant changes remain. removeAll detaches the old vector first,
so callback additions survive. Dealloc detaches first, exposes zero count to
callbacks and rejects further mutation. Release exceptions propagate with the
committed mutation intact. Balanced try/finally cleanup attempts every owned slot
and frees storage even when ordinary release calls throw; a later throw replaces
an earlier one under #781. Termination, cancellation boundaries and infinite user
recursion do not promise completion. The source recursion bound is logarithmic;
linear-memory stack readings and actual engine call-stack samples are separate
test evidence, not native-byte-stack measurements.

Enumeration uses the conventional target-layout state, a fresh buffer per loop,
and each returned itemsPtr. Mutable tokens advance for successful changes,
including equal-count replacement, and refuse generation overflow before commit.
The compiler checks before consuming each element, not after an unconditional
break. Mutation raises a real NSGenericException through the Foundation-provided
`objc_enumerationMutation` symbol. Apple's documentation establishes a catchable
exception; the name comes from GNUstep's implementation, not a locally observed
Apple exception name. A Foundation-free conformer may provide its own function;
omission is a named link error, without an implicit fatal fallback.

Primary contract references: Apple [memory management](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmPractical.html),
[fast enumeration](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ObjectiveC/Chapters/ocFastEnumeration.html),
[class clusters](https://developer.apple.com/library/archive/documentation/General/Conceptual/CocoaEncyclopedia/ClassClusters/ClassClusters.html),
and GNUstep [mutation provider](https://github.com/gnustep/libs-base/blob/master/Source/NSObject.m).
The approved V1/V2 design pins its observed upstream snapshots in the #779 ledger.

## Boundary and evidence

Manual ownership only: no ARC, weak references, Blocks or Objective-C++.
Zones, general object copying/descriptions,
formatting, other string encodings, proxies, runtime protocol reflection and
dynamic method mutation are outside this declared API set; unsupported calls
are not success stubs.

The compiler owns object layout, selectors, dispatch, startup, exception records
and scoped cleanup lowering. A private allocation prefix holds ownership state
without changing ivar offsets. Linker-owned exact immortal identities are
statically initialized before +load. The library owns lifecycle methods, string
storage and the pool stack; host and kernel have no object-lifetime policy.
Detailed design: `todos/FOUNDATION.md`.

`tests/foundation` supplies shared semantic programs for Node/Chromium, plus
actual gucOS `/bin/cc` integration on both hosts. Fault tests cap only Wasm's
memory maximum at its initial pages, leaving implementation instructions/data
unchanged, and exhaust real malloc. Execution records and independent-review
status are in `logs/2026-09-09/777-foundation.md` and
`logs/2026-09-10/778-foundation-strings.md`. The current #778 integration remains
unmerged, depends on #781 and awaits final mapped/backend validation; this API
document is not a gate result.
