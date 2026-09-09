# Small Foundation: NSObject and manual ownership (#777)

This is a real Objective-C source library for gucOS's static-link, single-threaded
Wasm runtime. It provides NSObject, NSAutoreleasePool and scoped autorelease
pools. It does not claim full Foundation or Apple/GNU runtime binary compatibility.
Unicode NSString/NSConstantString is the next authorized increment (#778).
Collections follow together with fast enumeration (#779).

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
is UINT_MAX. A heap instance of the same class remains mortal. The compiler's
existing NSConstantString provider requirement still applies; this increment
supplies no fake NSString implementation. Runtime tests' provider fixtures are
only ABI/provenance instruments.

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
silently dropped or performed early. This exception-free subset uses process
failure for these cases; it does not promise a catchable Foundation exception.
Ordinary explicit pool allocation still returns nil on exhaustion.

`@autoreleasepool` uses the same implementation and drains on fallthrough,
return, and break/continue/goto leaving its scope. Return values are evaluated
before cleanup, including aggregate values. A goto within the scope does not
drain. Entry by goto or outer-switch dispatch that bypasses pool creation is a
compile-time error. Explicit and scoped pools can nest with balanced lifetimes;
do not destroy a scoped pool indirectly by manually draining an enclosing pool
before its lexical exit. C longjmp across live pools, process exit and traps
provide no automatic scope unwinding.

## Boundary and evidence

Manual ownership only: no ARC, weak references, Objective-C exceptions, Blocks,
or Objective-C++. Zones, copying, descriptions, proxies, runtime protocol
reflection and dynamic method mutation are outside this declared API set;
unsupported calls are not success stubs. NSString and collection APIs will be
specified by their own increments.

The compiler owns object layout, selectors, dispatch, startup and scoped cleanup
lowering. A private allocation prefix holds ownership state without changing
ivar offsets. Linker-owned exact immortal identities are statically initialized
before +load. The library owns lifecycle methods and the pool stack; host and
kernel have no object-lifetime policy. Detailed design: `todos/FOUNDATION.md`.

`tests/foundation` supplies shared semantic programs for Node/Chromium, plus
actual gucOS `/bin/cc` integration on both hosts. Fault tests cap only Wasm's
memory maximum at its initial pages, leaving implementation instructions/data
unchanged, and exhaust real malloc. Execution records and independent-review
status are in `logs/2026-09-09/777-foundation.md`; this API document is not a gate
result.
