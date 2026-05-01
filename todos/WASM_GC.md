# Wasm GC — `__struct` and `__array` types

## Goal

Support Wasm GC heap-allocated structs and arrays managed by the engine's garbage collector, via `__struct` and `__array` type keywords. This is a much larger effort than `__externref` and needs careful design.

## Why

Wasm GC lets the host engine manage object lifetimes — no manual `malloc`/`free`, no linear-memory allocator, interop with host GC (JS objects can reference GC structs and vice versa without prevent collection). Enables C programs to create objects the JS side can inspect field-by-field, not just opaque blobs.

## `__struct`

### Syntax direction

Use a declaration syntax similar to C structs but more restricted:

```c
__struct Point {
    float x;
    float y;
};

__struct Node {
    int value;
    __ref Node next;   // nullable ref to another GC struct
};
```

Key differences from C structs:

- **No arbitrary nesting in C structs.** A `__struct` cannot be a field inside a regular C `struct`. It lives on the GC heap, not in linear memory.
- **No pointer arithmetic.** `__ref` is an opaque GC reference, not a linear-memory pointer.
- **No `union`-style overlapping.** Fields are typed and the engine enforces layout.
- **No bitfields, flexible array members, or anonymous inner structs.** Keep it clean.
- **Declarations must be top-level.** No `__struct` inside function bodies or as local type definitions. The Wasm type section needs them all known at compile time.
- **Field mutability.** Wasm GC struct fields can be mutable or immutable — expose this somehow (default mutable? `const` fields for immutable?).

### Semantics to figure out

- **`__ref` syntax.** How to spell a reference to a GC struct: `__ref Point`, `__ref Point?` (nullable), `Point*` (overloaded — confusing)?
- **Subtyping.** Wasm GC has structural subtyping. Do we expose this? Single inheritance via a `__struct Child : Parent` syntax? Or ignore subtyping for now?
- **Construction.** `__struct_new(Point, {1.0, 2.0})`? A `__new` keyword? Something else?
- **Field access.** `.` on a `__ref` should emit `struct.get` / `struct.set`. No `->` since there are no pointers involved. Or use `->` since the ref is pointer-like?
- **Null.** Nullable vs non-nullable refs. Wasm GC distinguishes `(ref null $Point)` from `(ref $Point)`. This matters for safety.
- **Casting.** `ref.cast`, `ref.test` for downcasting in a type hierarchy. Surface syntax TBD.

## `__array`

GC-managed arrays with a fixed element type and runtime length.

```c
__array(int) scores = __array_new(int, 100);
int x = __array_get(scores, 0);
__array_set(scores, 0, 42);
int len = __array_len(scores);
```

### Open questions

- **Syntax.** `__array(T)` as the type? Or `__gcarray` to avoid confusion with C arrays?
- **Immutable arrays.** Wasm GC supports them — useful for string-like data.
- **Multi-dimensional.** `__array(__array(int))` works in Wasm GC — just nested refs. Should be fine.

## Wasm binary impact

This is the hardest part implementation-wise:

### Type section overhaul

Wasm GC replaces the function-only type section with a recursive type group. Instead of just `0x60` (func), the type section now contains:

- `0x5F` — struct type (field count, then field types + mutability)
- `0x5E` — array type (element type + mutability)
- `0x60` — func type (same as today)
- `0x4E` — rec group wrapper (groups types that can reference each other)
- `0x50` — sub type (for subtyping/inheritance)

The existing `WasmModule.typeDefs` and binary emission need to generalize from "list of function types" to "list of any composite type."

### New opcodes (~30)

```
struct.new, struct.new_default
struct.get, struct.get_s, struct.get_u, struct.set
array.new, array.new_default, array.new_fixed, array.new_data, array.new_elem
array.get, array.get_s, array.get_u, array.set
array.len, array.fill, array.copy
ref.null, ref.is_null, ref.eq
ref.as_non_null, ref.cast, ref.test
br_on_null, br_on_non_null, br_on_cast, br_on_cast_fail
extern.internalize, extern.externalize
```

### Codegen constraints

Same fundamental constraint as `__externref`: GC references cannot live in linear memory. All the same restrictions apply — no `&`, no embedding in C structs, no va_args. But now there's also field access codegen, construction, and potentially subtype casting.

## Estimated effort

- `__externref` should be done first — it establishes the ref-type plumbing that GC builds on.
- Type section generalization: medium (rework `WasmModule.typeDefs` and binary emission)
- `__struct` with basic field access: medium-large
- `__array` with builtins: medium
- Subtyping/casting: medium, can defer
- Total: weeks of work, can be phased

## Phasing

### Phase 1: Ref type infra (done via `__externref` TODO)

### Phase 2: `__struct` basics
- Type section generalization (rec groups, struct type defs)
- `__struct` declarations → Wasm struct types in type section
- `__ref` type for GC references
- `struct.new`, `struct.get`, `struct.set` codegen
- Null refs, `ref.is_null`

### Phase 3: `__array`
- Array type defs in type section
- `__array_new`, `__array_get`, `__array_set`, `__array_len` builtins
- `array.new`, `array.get`, `array.set`, `array.len` codegen

### Phase 4: Subtyping and casting
- `__struct Child : Parent` syntax
- `ref.cast`, `ref.test` codegen
- `br_on_cast` for efficient type switches

## Open design questions

- **Interaction with `__externref`.** `extern.internalize` / `extern.externalize` convert between `externref` and `anyref`. Do we expose this? It's how you'd pass a GC struct to JS and get it back.
- **Strings.** Wasm GC is often paired with `stringref` for efficient string interop. Out of scope for now but worth knowing about.
- **i31ref.** Wasm GC has `i31ref` — a 31-bit integer packed into a ref. Useful for tagged values. Probably not needed for a C compiler.
- **Memory mixing.** Real programs will use both linear memory (legacy C code, malloc) and GC heap (new __struct code). The boundary needs to be clear — you can't memcpy a GC ref.
