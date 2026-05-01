# `__externref` — Wasm Reference Types

## Goal

Add `__externref` as a built-in type so C code can hold opaque host references (DOM nodes, JS objects, etc.) without encoding them as integers. Uses the Wasm Reference Types proposal, which is standard and shipped in all engines.

## What `__externref` is

An `externref` is a Wasm value that the host (JS) controls. Wasm code can receive one, pass it around, store it in locals/globals, and hand it back — but cannot inspect, cast, or store it in linear memory. The engine's GC manages liveness.

```c
__externref canvas;   // global — engine keeps it alive

void draw(__externref ctx) {
    fillRect(ctx, 0, 0, 100, 100);   // pass back to host
}
```

## Constraints

These are inherent to the Wasm spec, not design choices:

- Cannot take the address of an `__externref` (`&x` is illegal)
- Cannot put them in structs, unions, or arrays
- Cannot `sizeof(__externref)` — it has no size in linear memory
- Cannot pass through variadic functions (va arg blocks live in memory)
- Cannot cast to/from integer types
- Can only live in Wasm locals, globals, function params, and return values

## Implementation

### 1. Wasm type plumbing

Add `WT_EXTERNREF = { tag: "ref", ref: 0x6F }` alongside existing WT constants. Extend `wtEmit()` to handle `tag: "ref"` — just push the byte. Extend `wtEquals()` for the new tag.

### 2. C type system

Add `TEXTERNREF` to the `Types` namespace. Add `__externref` to the keyword table. Recognize it as a type specifier in the parser (same paths as `void`, `int`, etc.).

### 3. `cToWasmType()` mapping

```
TEXTERNREF → WT_EXTERNREF
```

### 4. Codegen — the main work

Ensure `__externref` variables use `LV_REGISTER` (Wasm local) storage, never `LV_MEMORY` / `LV_ADDR_FRAME` / `LV_ADDR_STATIC`. Emit errors for:

- `&x` where `x` is `__externref`
- `__externref` as a struct/union field
- `__externref` in an array type
- `sizeof(__externref)`
- Cast expressions involving `__externref`
- `__externref` in variadic call argument position

Global `__externref` variables map to Wasm globals initialized with `ref.null extern` (`0xD0 0x6F`).

### 5. Null and null-checking

- Assignment of `0` or `(void*)0` (NULL) to `__externref` emits `ref.null extern`
- Comparison `x == 0` / `x != 0` emits `ref.is_null` (opcode `0xD1`)
- Could also add `__ref_is_null(x)` builtin if explicit checking is preferred

### 6. Import/export

Already works — `__externref` params and returns in `__import` / `__export` function signatures just need the type to flow through `getWasmFunctionTypeIdForCFunctionType()`.

## Example usage

```c
__import("dom", "getElementById")
__externref getElementById(const char* id);

__import("dom", "setTextContent")
void setTextContent(__externref el, const char* text);

__export("tick")
void tick() {
    __externref el = getElementById("counter");
    setTextContent(el, "hello");
}
```

## Open questions

- **Tables:** The reference types proposal also allows `externref` tables (`table.get`/`table.set`). Worth supporting? This would let C code maintain indexed collections of host refs without globals for each one.
- **`funcref` as a type?** If we're adding `externref`, `__funcref` is the same amount of work. It would give a type-safe way to represent function references distinct from `i32` table indices.
- **DOM integration:** This pairs naturally with the DOM rendering TODO — host DOM nodes become `__externref` values instead of integer handles.
