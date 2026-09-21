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

## `__gcstr("...")` — string literals as imported constants (0041)

A string literal as an imported immutable `(ref extern)` global instead of a
data-segment address: module `"#"`, import NAME = the literal's bytes,
resolved at compile time by `importedStringConstants: '#'` (part of the
MUST-MATCH compile-options pair in host.js `runModule` / kernel.js
`_moduleFor`). Zero-copy, zero linear memory, one import per distinct
literal (dedup by content). `GCSTR(s)` in `guc.h` is the friendly spelling.

```c
__externref greeting = __gcstr("hello");        // no runtime conversion
int n = __wjs_length(__gcstr("hé" "llo"));      // concatenation applies; 5
__refextern r = __gcstr("x");                   // file scope: global.get of an
                                                // immutable import is a wasm
                                                // constant expression — this is
                                                // __refextern's ONE valid
                                                // global initializer
```

Rules: the argument must be a narrow (or u8) string literal, and its bytes
must be valid UTF-8 (they become a wasm import name; `\xNN` escapes that
break UTF-8 are compile errors). Type is `__refextern` (non-nullable, per
the js-string spec), decaying to `__externref` as usual. Prefer it over
`__jss`/`__jsstr` whenever the string is a literal — those convert through
linear memory on every call.

Loaders that can't pass compile options satisfy the imports with
`imports['#'] = new Proxy({}, {get: (_, name) => name})`.

Internals (compiler.js): parsed as `EIntrinsic` GC_STR carrying the
`EString`; imported globals occupy the bottom of the global index space, so
`generateCode` pre-registers every literal before the first defined global
(`addGlobalImport` throws otherwise — the index shift is enforced, not
relocated). Binary-shape test: `tests/host/test_gcstr_imports.js`.

## Embedded library: guc.h / guc.c

`guc.h` declares the wasm:js-string bindings and helper functions. `__guc.c` implements helpers — the compiler's dead code elimination removes unused functions.

```c
#include <guc.h>

__externref s = __jss("hello world");
int len = __wjs_length(s);
```

`__jss(const char *)` — convenience wrapper that calls `strlen` + `__jsstr2`.

## Host-provided imports (module "js")

All declared in `guc.h`:

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
