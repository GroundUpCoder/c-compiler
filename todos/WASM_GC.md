# Wasm GC — `__struct` and `__array` types

## Status: Implemented

The compiler supports Wasm GC heap-allocated structs and arrays managed by the engine's garbage collector. This builds on the `__externref` ref-type plumbing (see `EXTERNREF.md`).

## Why

Wasm GC lets the host engine manage object lifetimes — no manual `malloc`/`free`, no linear-memory allocator, interop with host GC (JS objects can reference GC structs and vice versa without preventing collection). Enables C programs to create objects the JS side can inspect field-by-field, not just opaque blobs.

## `__struct`

Declared with `__struct`, allocated with `__new`, fields accessed with `.`:

```c
__struct Point {
    float x;
    float y;
};

Point p = __new(Point, 1.0f, 2.0f);
float x = p.x;
p.y = 3.0f;
```

Differences from C structs:
- Lives on the GC heap, not in linear memory
- No pointer arithmetic — references are opaque
- No unions, bitfields, flexible array members, or anonymous inner structs
- Declarations must be top-level (needed at compile time for the Wasm type section)
- Fields are mutable by default; `const` fields emit immutable Wasm GC fields

### Subtyping / inheritance

Single inheritance via `__extends()`:

```c
__struct Node __extends(__struct Point) {
    int tag;
};
```

All `__struct` types are emitted as `sub` (open) so they can be extended. The compiler handles structural subtyping and cross-translation-unit inheritance.

## `__array(T)`

GC-managed arrays with a fixed element type and runtime length:

```c
__array(int) scores = __new(int, 100);   // 100 default-initialized elements
scores[0] = 42;
int len = __array_len(scores);

__array(int) vals = __new_array(int, 1, 2, 3);  // fixed-element init
```

Bulk operations:
- `__array_fill(arr, offset, value, count)`
- `__array_copy(dst, dstOff, src, srcOff, count)`

Packed field types (i8, i16) are supported for both struct fields and array elements, with sign-extended access variants.

## Reference intrinsics

| Intrinsic | Wasm opcode | Description |
|-----------|-------------|-------------|
| `__ref_is_null(ref)` | `ref.is_null` | Null check |
| `__ref_eq(a, b)` | `ref.eq` | Reference identity |
| `__ref_null(Type)` | `ref.null` | Typed null reference |
| `__ref_test(Type, ref)` | `ref.test` | Downcast type test |
| `__ref_cast(Type, ref)` | `ref.cast` | Downcast (traps on failure) |
| `__array_len(arr)` | `array.len` | Array length |
| `__array_fill(...)` | `array.fill` | Bulk fill |
| `__array_copy(...)` | `array.copy` | Bulk copy |

## Extern bridge

GC refs cross the JS/Wasm boundary via the `anyref`↔`externref` conversions:
- `__ref_as_extern(ref)` → `extern.convert_any`
- `__ref_as_any(ext)` → `any.convert_extern`

## Wasm binary encoding

### Type section

Uses recursive type groups (`0x4E`) to support mutual references. Each type entry is one of:
- `0x60` — func type (unchanged from baseline Wasm)
- `0x50` + `0x5F` — sub type wrapping a struct type (field count + fields with storage type + mutability)
- `0x5E` — array type (element storage type + mutability)

Packed field storage types: `0x78` (i8), `0x77` (i16).

### GC opcodes emitted (0xFB prefix)

Struct: `struct.new` (0x00), `struct.new_default` (0x01), `struct.get` (0x02), `struct.get_s` (0x03), `struct.get_u` (0x04), `struct.set` (0x05).

Array: `array.new` (0x06), `array.new_default` (0x07), `array.new_fixed` (0x08), `array.get` (0x0B), `array.get_s` (0x0C), `array.get_u` (0x0D), `array.set` (0x0E), `array.len` (0x0F), `array.fill` (0x10), `array.copy` (0x11).

Ref: `ref.test null` (0x15), `ref.cast null` (0x17), `any.convert_extern` (0x1A), `extern.convert_any` (0x1B).

## Not implemented

- `br_on_cast` / `br_on_cast_fail` — not needed yet (type switches use `ref.test` + branches)
- `i31ref` — packed 31-bit integers, not useful for a C compiler
- `stringref` — separate proposal, out of scope
- Immutable arrays — supported at the encoding level but not surfaced in the C syntax
- `funcref` tables of GC types
