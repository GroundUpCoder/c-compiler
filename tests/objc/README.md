# Objective-C compiler/runtime (#772, #775)

`.m` selects Objective-C; `.c` keeps C semantics. Both the Node CLI and gucOS
`/bin/cc` compile ordinary multi-file programs:

```
node compiler.js main.m model.m -o build/program.js
node build/program.js
```

The frontend parses user declarations, bodies and messages directly into the
existing typed AST. Compiler-owned runtime boilerplate uses the C parser. This
is a scoped Objective-C frontend with a gucOS runtime ABI, not Apple/GNU binary
compatibility or a complete Foundation/AppKit implementation.

## Implemented contract

| Area | Behavior |
|---|---|
| Classes | `@class`, `@interface Name [: Parent] [<Protocols>]`, `@implementation`, `@end`; superclass interface precedes subclass layout. Forward identity can be completed later. Implementations may add method declarations. |
| Object types | Distinct frontend object-pointer type with class identity, protocol qualifiers and ownership metadata; `id` is not `void *`. Representation remains four-byte i32 pointers, usable in C fields, arrays, parameters and returns. Const/volatile and typedefs preserve metadata. |
| Protocol types | Forward and method-bearing `@protocol` declarations, protocol inheritance, `id<P>` and `Name<P> *`; qualified dynamic receivers use protocol signatures. This is compile-time qualification, not runtime protocol reflection. |
| Ivars | Root class-pointer header; inherited storage preserves base tail padding. Complete C scalar/pointer/array/aggregate fields, public/protected/private access; default protected, local/parameter shadowing. |
| Methods | Instance/class methods, explicit C value types, complete struct/union parameters and returns, variadic methods. Fixed arguments retain declared types; tail arguments use C default promotions and the existing variadic arg-block ABI. |
| Signature resolution | Static receiver class selects the nearest declaration; unrelated classes may use different types for the same selector. Dynamic receivers require compatible visible signatures, checked again after the whole TU and at link to catch later declarations. Overrides and implementations allow covariant object results and contravariant object parameters; non-object ABI types remain compatible. |
| Linkage | One external initialized descriptor per class/metaclass definition. Opaque external selector objects are coalesced by spelling across TUs; SEL is their canonical address. Class layouts, protocol schemas and every declared method contract are checked across TUs; missing and duplicate definitions fail linking. |
| Dispatch | Actual receiver determines implementation. `super` preserves self and starts lookup at the lexical superclass/metaclass. A shared per-descriptor 16-slot cache serves hits; misses retain superclass lookup. Static typing never devirtualizes an open receiver. Missing methods abort. |
| Evaluation | Receiver and each argument evaluate once, including all operands of nil sends. Relative order follows the C call lowering; do not depend on a particular operand order. |
| Nil | Zero scalar/pointer/floating result; void no-op after argument evaluation. Aggregate results are zero-filled, including padding: an explicit gucOS contract rather than a claim about every native Objective-C ABI. |
| Eager initialization | All linked classes participate in startup, including unused classes. Runtime `+load` invokes only an own implementation, directly, superclass-first. No automatic inherited load and no implicit initialize merely for the direct load call. Messages from load use ordinary dispatch. Unrelated load order is unspecified. |
| Lazy initialization | Before the first ordinary class or instance send, initialize the actual receiver class, superclass-first. An inherited `+initialize` runs with each subclass as self, once per class. Same-thread reentry is permitted; child completion waits for an active parent's completion. Nil and bare class/literal references do not initialize. Lookup/cache access follows initialization. |
| Explicit lifetime | `guc_objc_alloc(Class)` zero-allocates an instance and sets isa; `guc_objc_dispose(id)` frees it and accepts nil. These existing custom allocation primitives do not send init/dealloc or manage ivar references. The Foundation source library (#777) implements alloc/init/dealloc/retain/release above them. A private runtime prefix stores ownership without changing ivar offsets; known compiler class/literal objects are permanent and raw dispose accepts them as a no-op. |
| Ownership | Manual by default; explicit `__unsafe_unretained` retains that unretained behavior and its type metadata. Owning/weak qualifiers fail loudly; no ARC or weak registry is implied. The separate Foundation library supplies manual autorelease pools; `@autoreleasepool` lowers all normal scope exits to that library. |
| C coexistence | C expressions, functions, preprocessing and source linking remain available. `__OBJC__` is scoped to each Objective-C TU, including headers/macros/token pasting; it does not leak into C compilation. |

Startup uses the existing exported `__wasm_call_ctors` host hook, after instance,
memory and imports are bound and before main. `host.js` invokes it on both hosts.
Embedders that instantiate Wasm directly must call this export before application
entry. Startup is idempotent per instance. The runtime is single-threaded, matching
the repository's no-shared-runtime-threads execution model; this is not a
thread-safe libobjc implementation.

The dispatch cache and initialization state live in canonical class descriptors,
so different TUs share state. No method-mutation or dynamic-module-loader API is
supplied. A future runtime that adds either must invalidate affected inherited
cache entries and intern selectors into the existing address namespace; it cannot
independently invent TU-local selector numbers or assume static receiver types
identify implementations. This records the boundary of this runtime, not a
claim that dlopen already exists.

## NSString literal/library boundary

`@"..."` has static type `NSString *`, with an implicit forward NSString identity
when needed. Adjacent ordinary/Objective-C literal tokens concatenate. Emitted
objects and payloads have static lifetime; globals can use their addresses as
constant initializers. No cross-TU literal-address deduplication is promised.

The concrete class is an externally supplied **NSConstantString**, descended from
NSString. The compiler supplies neither class implementation nor string methods.
Missing providers produce a named link diagnostic. Tests' provider classes are
explicit ABI fixtures, not a bundled Foundation implementation.

The payload adopts the modern GNUstep constant-string layout for wasm32:

| Offset | Field |
|---|---|
| 0 | Class isa, the concrete class descriptor's address |
| 4 | uint32 flags: 0 for ASCII, 2 for UTF-16LE |
| 8 | uint32 length in UTF-16 code units |
| 12 | uint32 payload byte count, excluding terminator |
| 16 | uint32 hash, initially zero |
| 20 | pointer to terminated payload |

Size is 24 bytes, alignment 4. ASCII payload alignment is 1; UTF-16 alignment is
2. Embedded NULs and supplementary-character surrogate pairs are preserved.
The linker checks the provider's complete inherited physical layout against this
shape. Matching this payload is a compiler/library seam, not GNUstep/libobjc2
runtime binary compatibility. The separate Foundation source library supplies NSObject, pools and a real
NSString/NSConstantString provider; see `os/foundation/README.md` for its supported
API and current integration status. AppKit is outside this subset.

Primary contracts: [Clang GNUstep code generation](https://github.com/llvm/llvm-project/blob/main/clang/lib/CodeGen/CGObjCGNU.cpp),
[GNUstep NSString ABI](https://github.com/gnustep/libs-base/blob/master/Headers/Foundation/NSString.h),
[Apple initialization implementation](https://github.com/apple-oss-distributions/objc4/blob/main/runtime/objc-initialize.mm),
[Apple load scheduling](https://github.com/apple-oss-distributions/objc4/blob/main/runtime/objc-loadmethod.mm),
[Clang method substitutability](https://clang.llvm.org/doxygen/SemaDeclObjC_8cpp_source.html).

## Language/runtime exceptions (#781)

`@try`, source-ordered `@catch(Class *e)` / `@catch(id e)` / `@catch(...)`,
`@finally`, `@throw object` and lexical bare `@throw;` use native Wasm EH.
Typed matching follows runtime class ancestry; nil reaches id/all handlers.
Catch variables are ordinary assignable locals; rethrow preserves the original
exception identity even after assignment or nested handlers. C catch-all handlers
also consume Objective-C records across translation units.

Each fresh throw holds its object until handled, suppressed or replaced. Runtime
records are heap-owned. Normal and exceptional finalization supports return,
break, continue and outward goto; scope-entry goto/switch dispatch is rejected.
Return expressions are evaluated once before cleanup. The compiler does not elide
named aggregate return slots: compare such cases with Clang's no-elide mode;
default Apple Clang may expose aliasing of a named local through its return slot.
Pools drain on normal directed exits, and remain undrained on exception escape.

Foreign Wasm/host exceptions reach catch-all only; exact rethrow identity is
preserved. Host process exit bypasses user handlers/finalizers, and genuine Wasm
traps are not language exceptions. A longjmp crossing an Objective-C exception
scope terminates with a diagnostic; local setjmp/longjmp stays supported. Record
allocation failure and uncaught export/startup/callback exceptions diagnose and
terminate with status 134. Internal calls to exported functions still propagate
to their callers. Async callback failures settle their owning runtime, cancel
queued callbacks, and preserve exit status or the original host error/trap;
`tests/host/test_async_lifecycle.js` covers both Node callback engine modes (#782).
Real NSException/string APIs belong to Foundation (#778).

Portable corpus: `exceptions.js`; Node entry: `tests/host/test_objc_exceptions.js`;
Chromium entry: `exceptions-browser.mjs`; actual `/bin/cc` on each OS host:
`test_objc_exceptions_e2e.js` / `os-objc-exceptions.mjs`. Run manifests under
`build/objc781` pin source and preserve failed attempts. These entrypoints are
validation mechanisms, not claims that a particular gate has run.

## Fast enumeration (#779)

`for (id object in collection)` and assignable object-pointer expression targets
use the declared NSFastEnumeration method ABI. Collection evaluation occurs once;
state and a 16-slot buffer are per loop. Returned itemsPtr is authoritative.
Continue advances/refills; break leaves the current element; exhaustion assigns
nil. Expression targets are reevaluated on each assignment, including final nil.
Mutation is checked before consuming each item against the first nonempty batch's
token. MRC inserts no collection/element ownership operations. Existing finally,
pool and transfer rules apply; goto/case entry into hidden state is rejected.
The external `void objc_enumerationMutation(id)` provider is required at link
time. Foundation supplies a catchable exception; custom conformers can provide
their own compatible implementation without Foundation. See
`tests/foundation/arrays-corpus.js` and `os/foundation/README.md`.

## Explicit boundaries

Categories/extensions, properties/dot messaging, synthesis,
optional protocol requirements and runtime protocol objects are not implemented.
Synchronization, ARC, Blocks and Objective-C++ remain outside
this compiler round. Packed classes, bitfield/incomplete/function ivars and
objects passed by value refuse. Boxing and collection literals are absent.
Undeclared selectors, missing declared method implementations and incompatible
signatures fail loudly. Promoting root instance methods to class methods,
forwarding and dynamic method resolution are not supplied. Standard runtime
headers and AppKit APIs are not bundled. NSObject and manual pools are supplied by the separately installed `foundation` source-library package; see `os/foundation/README.md`. `__guc_objc_*` names
and `__wasm_call_ctors` are compiler implementation symbols.

Only live allocated objects, class objects and valid library-provided constant
objects are non-nil receivers; forged pointers and use-after-free are undefined.

## Validation

```
node tests/host/test_objc.js
node tests/objc/browser.mjs
node tests/kernel/run.js --filter=objc
node tests/browser/os-sweep.mjs --filter=os-objc
```

Node and real Chromium compile the shared `cases.js`/`round2.js` corpus in both
inline modes, including multi-TU covariance and C-entry startup programs in both link orders. `os-script.js`
drives the positive corpus and multi-TU builds through actual `/bin/cc` and fresh
process execution on both OS hosts. AST metadata and negative link controls run
in the host test. `aggregate-abi.c` remains a C-only control; Objective-C aggregate
coverage is in `round2.js`. Execution evidence, pending gates and review status
belong in the #775 journal; this contract is not itself a green-gate record.
