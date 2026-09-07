# Objective-C compiler experiment (#772)

This branch experiments with an Objective-C subset in `compiler.js`. It is a
compiler/runtime spike, not a complete Objective-C compiler, an Apple/GNU ABI,
Foundation, AppKit, or Cocoa. It makes no desktop or IDE changes.

Compile an ordinary `.m` file with the existing CLI:

```
node compiler.js tests/objc/core.m -o build/objc/core.js
node build/objc/core.js
```

`.m` selects the experimental frontend; `.c` keeps C semantics and rejects
Objective-C syntax. `/bin/cc file.m -o program` uses the same frontend in gucOS.
The compiler predefines `__OBJC__` while preprocessing that translation unit.
There is no `-x`, `-fobjc-arc`, or Objective-C++ mode in this experiment.

## Implemented contract

| Area | Support |
|---|---|
| Declarations | `@interface Name [: Parent]`, `@implementation Name`, `@end`; superclass interface precedes subclass; each class has one implementation in the same `.m` TU. Every implemented method is explicitly declared in its own interface. |
| Objects | Distinct class pointer types (`Name *`), inherited object storage with base tail padding preserved, upcasts, `id`, `Class`, `nil`, `Nil`. The internal representation of `id` is `void *`; this is not full Objective-C static type checking. |
| Ivars | Complete ordinary C scalar/pointer/array/aggregate members; default protected visibility, `@private`, `@protected`, `@public`; implicit ivar names and `self->ivar`; local/parameter shadowing. |
| Methods | Instance `-` and class `+` methods; explicit return/parameter types; void, integer including 64-bit, pointer including function pointers, float/double/long double using existing C scalar representation. Ordinary C method bodies. |
| Selectors | Unary, keyword and empty subsequent keyword components; `@selector(...)`, `_cmd`, TU-local selector identity. One compatible signature per selector and method kind across the TU. |
| Messaging | Runtime lookup through class/metaclass inheritance; overrides; recursive/nested messages; class-valued `Class`/`id`; `super` starts at the lexical superclass and preserves the actual receiver. Dynamic `id` sends with conflicting instance/class signatures fail at compile time. |
| Evaluation | Receiver and each argument evaluated once. Arguments still evaluate for nil. Relative evaluation order follows the existing C call lowering; callers must not depend on a particular order. |
| Nil | Zero for supported integer/pointer/floating returns; void no-op after argument evaluation. |
| Lifetime | `guc_objc_alloc(Class)` zero-allocates the class's instance size and sets its class pointer; nil class or allocation failure returns nil. `guc_objc_dispose(id)` frees the object, accepts nil. Both are custom experiment APIs, available in `.m` files without an additional header. |
| C coexistence | Existing C expressions, statements, functions, preprocessing and source linking; C array brackets remain C subscripts. `@` is tokenized before macro expansion, including included headers. |

The runtime has static class/metaclass descriptors and method tables. Message
ASTs call compiler-generated typed helpers, which perform lookup, cast the IMP
to the method's exact signature, and invoke it through the existing Wasm
indirect-call machinery. Method bodies and message operands are parsed directly
into the existing typed AST. Compiler-owned runtime boilerplate uses the C parser;
user Objective-C source is never rewritten into C text.

Allocation does not send `init`, and disposal does not send `dealloc` or release
ivar references. Ownership is entirely explicit. A root class may define its own
`+alloc`, `-init`, `-dealloc`, or retain/release methods; those are ordinary user
methods, not built-in NSObject behavior. Only live allocated objects or class
objects are valid non-nil receivers; use-after-free and forged receivers have
undefined behavior. A missing runtime method aborts the process; forwarding and
method resolution hooks are not part of this contract.

## Refused/outside this experiment

- More than one Objective-C translation unit in a program; cross-TU class/selector
  registration, dynamic class loading and runtime method replacement.
- Aggregate arguments/returns in Objective-C methods, variadic methods, GC reference
  signatures, incomplete/function/bitfield ivars, packed class layouts, objects by value.
- Forward class declarations, categories/extensions, protocols, properties and dot
  messaging, synthesis/dynamic declarations, fast enumeration, exceptions/synchronization,
  ARC/ownership qualifiers, autorelease pools, Blocks, Objective-C++.
- Object strings/boxed literals/collection literals; Foundation/AppKit/NSObject and
  Apple/GNU runtime headers or binary compatibility. There is no conventional
  `<objc/objc.h>` or `<objc/runtime.h>` library supplied by this spike.
- Implicit method types, undeclared method signatures, missing class/method implementations,
  and selector signatures that conflict within a method kind.

Unsupported syntax fails compilation, sometimes through the ordinary C parser's
source-located diagnostic. Class sends require class-method declarations; promoting root instance methods
to class methods is outside this subset and is refused.
Standard library classes/APIs are absent rather than
success-reporting stubs. `__guc_objc_*` names are reserved implementation details.
No implementation schedule or compatibility percentage is claimed.

## Validation entry points

```
node tests/host/test_objc.js
node tests/objc/browser.mjs
node tests/kernel/run.js --filter=objc
node tests/browser/os-sweep.mjs --filter=os-objc
```

The Node and Chromium tests compile the same source corpus under default and
no-inline settings and execute the resulting Wasm. `core.m` also builds/runs
through `/bin/cc` on both OS hosts. The browser test is discovered by the normal
sweep, the Node test is enrolled in host, and the OS test in kernel. `tests/objc/`
changes map to all three suites. Actual execution records and gate scope belong
in the committed #772 journal, not in this contract.

`aggregate-abi.c` is explicitly a **C-only control** for the existing compiler's
aggregate indirect-call ABI. It is not an Objective-C demo. The emitter adds a
hidden return pointer for C aggregate returns; extending the Objective-C helpers
requires defining the target's nil aggregate result and testing hidden-pointer
lifetime, argument copies, nested sends and overrides. The current method parser
refuses that ABI rather than applying the scalar helper to it.
