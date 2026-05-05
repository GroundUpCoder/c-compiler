# Wasm GC — `__struct` and `__array` types

## Status: Implemented

The compiler supports Wasm GC heap-allocated structs and arrays managed by the engine's garbage collector.

## Why

Wasm GC lets the host engine manage object lifetimes — no manual `malloc`/`free`, no linear-memory allocator, interop with host GC (JS objects can reference GC structs and vice versa without preventing collection). Enables C programs to create objects the JS side can inspect field-by-field, not just opaque blobs.

## Preferred syntax (read this first)

A GC struct **value** is conceptually a reference to a heap-allocated object. To match C's pointer idioms (and to keep clang IDE tooling happy when shimmed), **always spell GC struct refs with `*`** and access fields with `->`:

```c
__struct Point { int x; int y; };

__struct Point *p = __new(__struct Point, 3, 7);
p->x = 99;
printf("%d\n", p->x);
```

For GC arrays, **never** add `*` — arrays don't have a "pointer to" idiom in C, and the compiler will reject `__array(T) *`:

```c
__array(int) arr = __array_new(int, 5);       // OK
arr[0] = 42;
__array_len(arr);

__array(int) *bad = ...;                      // ERROR — write `__array(int) name`
```

When an array's element type is a GC struct, spell that with `*` too:

```c
__array(__struct Point *) ps = __array_of(__struct Point *,
    __new(__struct Point, 1, 2),
    __new(__struct Point, 3, 4));
ps[0]->x;   // works because element type already says `*`
```

### `__new` takes `__struct Foo` (no `*`)

`__new` takes a struct type spelled as `__struct Foo` — keep the `__struct` keyword (so the IDE can navigate the type) but drop the `*` (since `__new` always returns a struct ref). `__struct_new` is an alias for `__new` if you prefer the more explicit spelling.

| Allocation | Always write |
|---|---|
| Struct | `__new(__struct Foo, args...)` |
| Array (default-init) | `__array_new(T, n)` |
| Array (filled) | `__array_new(T, n, val)` |
| Array (literal values) | `__array_of(T, v1, v2, ...)` |

The first argument to `__new` is parsed as a general type expression, so any type that resolves to a GC struct works — including typedefs (`typedef __struct Foo MyT; __new(MyT, ...)`) and trailing `*` (`__new(__struct Foo *, ...)` is tolerated since `__struct Foo` and `__struct Foo *` are the same WASM type). The error case (e.g. `__new(int, ...)`) is caught after parsing.

IDE macro shims: `#define __new(T, ...) ((T*){0})` (T = `__struct Foo` → `((struct Foo*){0})` with the `__struct=struct` shim), `#define __array_new(T, ...) ((__array(T)){0})`, `#define __array_of(T, ...) ((__array(T)){0})`.

The same `*` consistency applies to type-arg intrinsics that can take a struct ref: `__ref_test(__struct Foo *, x)`, `__ref_cast(__struct Foo *, x)`, `__ref_null(__struct Foo *)`. **Exception**: `__extends(__struct Animal)` stays bare — it names a parent class (mirroring C++'s `class Dog : public Animal`), and the parent is always a struct, never an array, so there's no consistency pressure from another form.

### Why both forms work

Because GC refs are already "one level of indirection" semantically, the compiler treats `__struct Foo` and `__struct Foo *` (and `**`, `***` ...) as the same WASM type — they're aliases. Bare `__struct Foo p; p.x = 1;` works exactly the same as `__struct Foo *p; p->x = 1;`. The `*`/`->` form is just the **preferred** spelling because it matches C convention and is shimmable for clang IDE tooling.

The `gc/pointer_sugar` test exercises this equivalence explicitly. Every other test uses the preferred form.

## `__struct` definition

Field declarations inside the body use the same spelling rule — GC struct fields with `*`, GC array fields without:

```c
__struct Node {
    int value;
    __struct Node *next;       // recursive ref — '*' form
    __array(int) children;     // array — no '*'
};
```

Differences from C structs:
- Lives on the GC heap, not in linear memory
- Reference semantics — assignment aliases, doesn't copy
- No pointer arithmetic — references are opaque
- `&gc_var` is rejected
- No unions, bitfields, flexible array members, anonymous inner structs
- Definitions must be top-level (Wasm type section needs them at compile time)

### Inheritance via `__extends`

Single inheritance using an explicit `__extends(__struct Parent)` marker as the first member, followed by a verbatim repeat of the parent's fields:

```c
__struct Animal { int id; };

__struct Dog {
    __extends(__struct Animal);
    int id;       // must repeat parent's fields, in order, with same names + types
    int paws;
};
```

The compiler validates the prefix-match strictly. Fields after the parent's are the new additions for the subclass.

Implicit upcast works automatically (Dog → Animal in function calls or assignments). Explicit downcast uses `__ref_cast(__struct Dog *, animal)`.

## `__array(T)`

GC-managed arrays with a fixed element type and runtime length:

```c
__array(int) scores = __array_new(int, 100);    // 100 default-initialized
scores[0] = 42;
int len = __array_len(scores);

__array(int) vals = __array_of(int, 1, 2, 3);  // literal element list
__array(int) ones = __array_new(int, 5, 1);    // 5 elements, all = 1
```

Bulk operations:
- `__array_fill(arr, offset, value, count)`
- `__array_copy(dst, dstOff, src, srcOff, count)` — handles overlap

Packed field types (i8, i16) are supported for both struct fields and array elements, with sign-extended/zero-extended access depending on the C-level signedness.

## Reference intrinsics

| Intrinsic | Wasm opcode | Description |
|-----------|-------------|-------------|
| `__ref_is_null(ref)` | `ref.is_null` | Null check |
| `__ref_eq(a, b)` | `ref.eq` | Reference identity |
| `__ref_null(__struct Foo *)` | `ref.null` | Typed null reference |
| `__ref_test(__struct Foo *, ref)` | `ref.test` | Type test — false on null (instance-of) |
| `__ref_test_null(__struct Foo *, ref)` | `ref.test null` | Type-lattice test — true on null |
| `__ref_cast(__struct Foo *, ref)` | `ref.cast` | Downcast — traps on null or type mismatch |
| `__ref_cast_null(__struct Foo *, ref)` | `ref.cast null` | Downcast — null passes through, traps only on type mismatch |
| `__array_len(arr)` | `array.len` | Array length |
| `__array_fill(...)` | `array.fill` | Bulk fill |
| `__array_copy(...)` | `array.copy` | Bulk copy |
| `__ref_as_extern(ref)` | `extern.convert_any` | Wrap GC ref as externref (for JS) |
| `__ref_as_eq(ext)` | `any.convert_extern` + `ref.cast eq` | Unwrap externref to eqref (traps if not eq-compatible) |

The `_null` suffix mirrors the WASM operator name suffix exactly. Pick the
strict (`__ref_test` / `__ref_cast`) form by default — it answers the
"is this an instance of T?" question that most C code wants. Reach for
the `_null` form when you specifically want to ask "is this in the
`(ref null T)` lattice?" or want a non-trapping cast on null. For typical
casting with C-pointer "null casts to null" behavior, prefer `__cast(T, x)`
instead — it uses the nullable variant under the hood.

## `__eqref` + implicit boxing + `__cast(T, x)` — universal type + conversion

`__eqref` is the GC-universe supertype for all eq-compatible reference types (`ref null eq`, heap byte 0x6D). It can hold any GC struct, GC array, or boxed primitive. Acts as the "any" type for generic GC code.

We use `eqref` rather than `anyref` because:
- All concrete GC types we use (struct, array, i31) are in the eq lattice
- `ref.eq` works directly on eqref operands — `if (eq1 == eq2)` is just identity comparison
- We lose nothing in practice (current WASM GC has no concrete heap types in `any` but not in `eq`)

**Implicit conversions to `__eqref` are allowed** in every context an implicit conversion would happen — variable init/assignment, function call args, return statements:

```c
void f(__eqref x);
f(42);            // implicit box int → __eqref
f(3.14);          // implicit box double → __eqref
__eqref e = 100;  // implicit box on init
return n;         // implicit box on return (where return type is __eqref)
```

The 0/NULL pointer constant convention is preserved: `__eqref e = 0;` and `__eqref e;` both give null. Use `__cast(__eqref, 0)` for a boxed-zero distinct from null.

For unboxing and explicit conversions, use `__cast(TargetType, expr)`. It dispatches at codegen based on source/target type combo:

| Source → Target | Mechanism |
|---|---|
| Same type | identity (no-op) |
| prim → prim | Numeric conversion (existing emitConversion) |
| prim → `__eqref` | Auto-allocate internal box struct (`__Box_i32`/`__Box_i64`/`__Box_f32`/`__Box_f64` — immutable single-field structs to avoid colliding with user types under structural dedup), `struct.new`, implicit upcast to eqref |
| `__eqref` → prim | `ref.cast` to box struct, `struct.get` field 0 |
| GC ref → `__eqref` | Implicit subtype upcast (no opcode) |
| `__eqref` → GC ref | `ref.cast` (traps on mismatch) |
| GC ref → GC ref | `ref.cast` (downcast / sidecast — same as `__ref_cast`) |
| GC ref → `__externref` | `extern.convert_any` (cheap retag) |
| `__externref` → `__eqref` | `any.convert_extern` + `ref.cast eq` |

Discriminated unions become idiomatic:

```c
__eqref store = ...;
if (__ref_test(__struct Point *, store)) { ... }
else if (__ref_test(__struct Color *, store)) { ... }
// boxed primitives don't have user-visible test types — treat the
// "doesn't match any user struct" case as the primitive case.
```

Internal box structs are immutable single-field structs. This intentionally makes them structurally distinct from any user struct (which would be mutable), preserving `__ref_test` discrimination.

Currently NOT supported: `prim ↔ __externref` (would need host calls) and `__eqref → __externref` is fine (auto-promotes via `extern.convert_any`).

## Boolean / null sugar

Refs may be used in boolean / null contexts as sugar for the explicit intrinsics:

| Sugar | Equivalent |
|---|---|
| `if (ref)`, `while (ref)`, `for(...; ref; ...)`, `ref ? a : b` | `if (!__ref_is_null(ref))` etc |
| `!ref` | `__ref_is_null(ref)` |
| `ref == 0`, `ref == NULL` | `__ref_is_null(ref)` |
| `ref != 0`, `ref != NULL` | `!__ref_is_null(ref)` |
| `ref1 == ref2`, `ref1 != ref2` | `__ref_eq` (identity) |
| `ref && other`, `ref \|\| other` | boolean coercion |
| `ref_var = 0;`, `__struct Foo *p = NULL;` | `= __ref_null(__struct Foo *)` |

Both forms are valid; the explicit intrinsic form survives the IDE macro shim cleanly, the sugar reads as idiomatic C in the source. Pick per your taste.

Rejected (no meaningful semantics): `ref < other`, `ref >= 0`, etc. Also `__struct Foo *p = 5;` — only the literal `0` / `NULL` is allowed as a non-ref source.

## Auto + GC

C23 `auto` pairs naturally with GC types — the type spelling can stay on the right side of the `=`:

```c
auto p = __new(__struct Point, 7, 11);
p->x;

auto arr = __array_of(int, 1, 2, 3);
for (auto cur = head; cur; cur = cur->next) printf("%d\n", cur->v);
```

## Wasm binary encoding

### Type section

Uses Tarjan SCC + minimal rec groups (`0x4E`) — each non-recursive type gets its own singleton rec group, mutually-recursive types share a rec group. This lets WASM canonicalize structurally-equivalent types (so cross-TU `__struct Foo` instances unify to one canonical type even when recursive).

Each type entry is one of:
- `0x60` — func type
- `0x50` + `0x5F` — sub type wrapping a struct type (open subtype, allows extension)
- `0x5E` — array type (element storage type + mutability)

Packed field storage types: `0x78` (i8), `0x77` (i16).

### GC opcodes emitted (0xFB prefix)

| Group | Opcodes |
|---|---|
| Struct | `struct.new` (0x00), `struct.new_default` (0x01), `struct.get` (0x02), `struct.get_s` (0x03), `struct.get_u` (0x04), `struct.set` (0x05) |
| Array | `array.new` (0x06), `array.new_default` (0x07), `array.new_fixed` (0x08), `array.get` (0x0B), `array.get_s` (0x0C), `array.get_u` (0x0D), `array.set` (0x0E), `array.len` (0x0F), `array.fill` (0x10), `array.copy` (0x11) |
| Ref | `ref.test` (0x14), `ref.test null` (0x15), `ref.cast` (0x16), `ref.cast null` (0x17), `any.convert_extern` (0x1A), `extern.convert_any` (0x1B) |

## Not implemented

- `br_on_cast` / `br_on_cast_fail` — not needed (type switches use `ref.test` + branches)
- `i31ref` — packed 31-bit integers, not useful for a C compiler
- `stringref` — separate proposal, out of scope
- Immutable struct/array fields — encoding supported, no C surface
- Non-nullable refs `(ref T)` — except `__refextern`; full type-system distinction would need flow narrowing
- `array.new_data` / `array.new_elem` — alloc array from data segment
- `funcref` tables of GC types — separate from i32 indirect-call table
