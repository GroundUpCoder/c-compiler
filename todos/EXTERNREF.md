# `__externref` & `__refextern` — Wasm Reference Types

## Status: Implemented

The compiler supports both nullable (`__externref`) and non-nullable (`__refextern`) opaque host references via the Wasm Reference Types proposal.

## Types

| C type | Wasm encoding | Nullable | Use case |
|--------|---------------|----------|----------|
| `__externref` | `0x6F` (externref) | yes | General host values, may be null |
| `__refextern` | `0x64 0x6F` (ref extern) | no | Return types from wasm:js-string builtins |

Both types share the same constraints — they are opaque references managed by the host GC:

- Cannot take the address (`&x` is illegal)
- Cannot put in structs, unions, or arrays
- Cannot `sizeof()`
- Cannot cast to/from integer types
- Can only live in Wasm locals, globals, function params, and return values

## Null handling

- `__externref x = 0;` emits `ref.null extern`
- `x == 0` / `x != 0` emits `ref.is_null`
- `if (x)` / `!x` use `ref.is_null` for boolean conversion
- `__refextern` cannot be used for global variables (no valid initializer exists) — use `__externref` for globals

## `__import("module", "name")`

Custom import module/name pairs for function declarations:

```c
__import("wasm:js-string", "length")
int __wjs_length(__externref s);
```

- Two args: `__import("module", "name")` — sets both module and import name
- One arg: `__import("module")` — sets module name, uses function name as import name
- No args: `__import` — defaults to module `"c"` with function name

## wasm:js-string builtins

Engine-provided string operations imported from `"wasm:js-string"`. Enabled via `WebAssembly.Module(bytes, { builtins: ['js-string'] })` in host.js.

Bindings declared in `guc.h`:

| Function | Signature |
|----------|-----------|
| `__wjs_length` | `int (externref)` |
| `__wjs_charCodeAt` | `int (externref, int)` |
| `__wjs_codePointAt` | `int (externref, int)` |
| `__wjs_equals` | `int (externref, externref)` |
| `__wjs_compare` | `int (externref, externref)` |
| `__wjs_concat` | `refextern (externref, externref)` |
| `__wjs_substring` | `refextern (externref, int, int)` |
| `__wjs_fromCharCode` | `refextern (int)` |
| `__wjs_fromCodePoint` | `refextern (int)` |
| `__wjs_test` | `int (externref)` |
| `__wjs_cast` | `refextern (externref)` |

Not bound (require Wasm GC array types): `fromCharCodeArray`, `intoCharCodeArray`.

## Embedded library: guc.h / guc.c

`guc.h` declares the wasm:js-string bindings and helper functions. `__guc.c` implements helpers — the compiler's dead code elimination removes unused functions.

```c
#include <guc.h>

__externref s = __jss("hello world");
int len = __wjs_length(s);
```

`__jss(const char *)` — convenience wrapper that calls `strlen` + `__jsstr2`.

## Host-provided imports (module "js")

All declared in `guc.h` (`externref.h` redirects to `guc.h`):

| Function | Purpose |
|----------|---------|
| `__jsstr(const char *)` | C string → JS string (null-terminated) |
| `__jsstr2(const char *, int)` | C string → JS string (with length) |
| `__jsstr_utf8len(externref)` | UTF-8 byte length of a JS string |
| `__jsstr_read(externref, char *, int, int *)` | Encode JS string to UTF-8 buffer; returns 1 if complete, 0 if truncated |
| `__jsglobal()` | Returns `globalThis` |
| `__jslog(externref)` | `console.log` |
| `__jsgetattr(externref, externref)` | Property access |

## Open questions

- **Tables:** `externref` tables (`table.get`/`table.set`) would allow indexed collections of host refs. Not yet implemented.
- **`funcref`:** Same mechanism could support `__funcref` for type-safe function references.
- **DOM integration:** Host DOM nodes as `__externref` values instead of integer handles.
